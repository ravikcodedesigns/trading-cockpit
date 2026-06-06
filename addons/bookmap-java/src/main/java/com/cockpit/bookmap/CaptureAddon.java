// CaptureAddon — Personal research/backtest capture tool for the trading-cockpit project.
//
// PURPOSE
//   Logs MBO order events (send / replace / cancel), L2 depth updates, and
//   trade ticks for each attached instrument to a local file on the user's
//   own machine. Used to develop and backtest orderflow-based trading
//   strategies (iceberg detection, sweep classification, footprint analysis).
//
// SCOPE — personal / non-commercial research use only.
//   - The log file lives in $HOME/cockpit-mbo-capture/ on the local machine.
//   - Data is consumed by the user's own offline analysis scripts.
//   - The addon performs NO network I/O of any kind.
//   - The addon does NOT redistribute, share, or transmit market data to any
//     third party. Data never leaves the machine Bookmap is running on.
//   - The author retains all market-data redistribution restrictions imposed
//     by Bookmap and the underlying data vendor (e.g. CME, dxFeed).
//
// IMPLEMENTATION NOTES
//   - Listener callbacks return immediately after a buffered append; periodic
//     flush every 256 events keeps disk overhead negligible.
//   - IO failures are caught and logged to stderr without re-throwing — the
//     Bookmap listener thread is never crashed.
//   - Concurrent access to the log writer is serialized with a ReentrantLock.
//
// HOW TO USE (developer)
//   1. Build:   cd addons/bookmap-java && gradle build
//   2. Install: open Bookmap → Settings → Configure API plugins → Add the
//               built JAR at build/libs/cockpit-bookmap-mbo-capture-*.jar
//   3. Attach:  on any chart, right-click → strategy / indicator dropdown →
//               check "Cockpit MBO Capture"

package com.cockpit.bookmap;

import com.google.gson.Gson;
import velox.api.layer1.annotations.Layer1ApiVersion;
import velox.api.layer1.annotations.Layer1ApiVersionValue;
import velox.api.layer1.annotations.Layer1SimpleAttachable;
import velox.api.layer1.annotations.Layer1StrategyName;
import velox.api.layer1.annotations.UnrestrictedData;
import velox.api.layer1.data.InstrumentInfo;
import velox.api.layer1.data.TradeInfo;
import velox.api.layer1.simplified.Api;
import velox.api.layer1.simplified.CustomModule;
import velox.api.layer1.simplified.DepthDataListener;
import velox.api.layer1.simplified.InitialState;
import velox.api.layer1.simplified.MarketByOrderDepthDataListener;
import velox.api.layer1.simplified.TradeDataListener;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;

@Layer1SimpleAttachable
@Layer1StrategyName("Cockpit MBO Capture")
@Layer1ApiVersion(Layer1ApiVersionValue.VERSION2)
@UnrestrictedData  // Required for addons that consume MBO/raw orderflow on restricted feeds (BookmapData, dxFeed)
public class CaptureAddon
        implements CustomModule, TradeDataListener, DepthDataListener, MarketByOrderDepthDataListener {

    private static final Gson GSON = new Gson();
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ISO_LOCAL_DATE;
    private static final Path LOG_DIR = Paths.get(System.getProperty("user.home"), "cockpit-mbo-capture");

    private String alias = "";
    private double pips = 1.0;            // price per tick (e.g. 0.25 for NQ); used to convert int prices
    private BufferedWriter logWriter;
    private final ReentrantLock writeLock = new ReentrantLock();
    private long eventCount = 0;
    private long lastSummaryTs = 0;

    private final Map<String, Long> kindCounts = new HashMap<>();

    // ── CustomModule lifecycle ────────────────────────────────────────────

    @Override
    public void initialize(String alias, InstrumentInfo info, Api api, InitialState initialState) {
        this.alias = alias;
        this.pips = info.pips;
        try {
            Files.createDirectories(LOG_DIR);
            String date = LocalDate.now().format(DATE_FMT);
            Path file = LOG_DIR.resolve(String.format("%s-%s.log", date, sanitize(alias)));
            logWriter = Files.newBufferedWriter(
                    file,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND);
            log("init", Map.of(
                    "alias", alias,
                    "full_name", info.fullName,
                    "pips", info.pips,
                    "size_multiplier", info.sizeMultiplier,
                    "is_crypto", info.isCrypto,
                    "log_file", file.toString()
            ));
            System.out.println("[cockpit-mbo] Attached to " + alias + " | logging to " + file);
        } catch (IOException e) {
            System.err.println("[cockpit-mbo] Failed to open log file: " + e);
        }
    }

    @Override
    public void stop() {
        log("stop", Map.of("alias", alias, "total_events", eventCount));
        if (logWriter != null) {
            try { logWriter.close(); } catch (IOException ignored) {}
        }
    }

    // ── Trade events ──────────────────────────────────────────────────────

    @Override
    public void onTrade(double price, int size, TradeInfo tradeInfo) {
        // Trade prices arrive in integer ticks (the same scale as onDepth's
        // int price). We log both the raw tick value and the per-pips dollar
        // value to keep downstream consumers flexible.
        log("trade", Map.of(
                "price_int", price,
                "price", price * pips,
                "size", size,
                "is_otc", tradeInfo.isOtc,
                "is_bid_aggressor", tradeInfo.isBidAggressor,
                "is_execution_start", tradeInfo.isExecutionStart,
                "is_execution_end", tradeInfo.isExecutionEnd,
                "aggressor_order_id", tradeInfo.aggressorOrderId == null ? "" : tradeInfo.aggressorOrderId,
                "passive_order_id", tradeInfo.passiveOrderId == null ? "" : tradeInfo.passiveOrderId
        ));
    }

    // ── L2 depth events ───────────────────────────────────────────────────

    @Override
    public void onDepth(boolean isBid, int price, int size) {
        log("depth", Map.of(
                "is_bid", isBid,
                "price_int", price,
                "price", price * pips,
                "size", size
        ));
    }

    // ── MBO events (the new stuff) ───────────────────────────────────────

    @Override
    public void send(String orderId, boolean isBid, int price, int size) {
        log("mbo_send", Map.of(
                "order_id", orderId,
                "is_bid", isBid,
                "price_int", price,
                "price", price * pips,
                "size", size
        ));
    }

    @Override
    public void replace(String orderId, int price, int size) {
        log("mbo_replace", Map.of(
                "order_id", orderId,
                "price_int", price,
                "price", price * pips,
                "size", size
        ));
    }

    @Override
    public void cancel(String orderId) {
        log("mbo_cancel", Map.of("order_id", orderId));
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    private void log(String kind, Map<String, Object> data) {
        eventCount++;
        kindCounts.merge(kind, 1L, Long::sum);
        if (logWriter == null) return;
        Map<String, Object> record = new HashMap<>();
        record.put("ts_ms", System.currentTimeMillis());
        record.put("alias", alias);
        record.put("kind", kind);
        record.put("data", data);
        String line = GSON.toJson(record);
        writeLock.lock();
        try {
            logWriter.write(line);
            logWriter.newLine();
            // Flush periodically so events are visible during tailing
            if ((eventCount & 0xFF) == 0) logWriter.flush();
            // Periodic summary to stdout
            long now = System.currentTimeMillis();
            if (now - lastSummaryTs > 5000) {
                lastSummaryTs = now;
                System.out.println("[cockpit-mbo " + alias + "] " + eventCount + " events, counts=" + kindCounts);
            }
        } catch (IOException e) {
            // Don't crash the listener thread on IO errors
            StringWriter sw = new StringWriter();
            e.printStackTrace(new PrintWriter(sw));
            System.err.println("[cockpit-mbo] log write failed: " + sw);
        } finally {
            writeLock.unlock();
        }
    }

    private static String sanitize(String s) {
        return s == null ? "unknown" : s.replaceAll("[^a-zA-Z0-9_-]", "_");
    }
}
