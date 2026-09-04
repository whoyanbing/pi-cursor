import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-cursor-test-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
