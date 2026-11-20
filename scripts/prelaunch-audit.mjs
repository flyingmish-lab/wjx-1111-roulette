// Regression probes use isolated DOMs and fake transport, never production data.
import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['--test','--test-name-pattern=reliability:','tests/player-ui.test.mjs'],{stdio:'inherit'});
process.exitCode=result.status ?? 1;
