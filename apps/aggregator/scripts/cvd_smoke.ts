// Smoke test for CvdSession. Verifies hydrate() against today's ticks.db.
import { cvdSession } from '../src/cvd-session.js';

cvdSession.hydrate(['NQ']);
console.log('Hydrate snapshot:', cvdSession.snapshot());
console.log('NQ session CVD :', cvdSession.get('NQ'));
