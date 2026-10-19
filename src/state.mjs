/** Local machine state. Tests and portable installs can choose an isolated
 * directory without changing the user's real installation. */
import os from 'node:os'
import path from 'node:path'

export const stateDir = () => process.env.AXMAP_STATE_DIR
  ? path.resolve(process.env.AXMAP_STATE_DIR)
  : path.join(os.homedir(), '.axmap')
