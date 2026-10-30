// Vercel Function. vercel.json rewrites /mcp and /mcp/<key> here.
import { handleMcpRequest } from "../src/http.js";

export default { fetch: handleMcpRequest };
