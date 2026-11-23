// Mock of `media_allow_previews` (Rust media/): every path is "allowed"; the mock has no local files to serve.
import { registerMockCommand } from '../registry';

registerMockCommand('media_allow_previews', (args) => (Array.isArray(args.paths) ? args.paths.length : 0));
