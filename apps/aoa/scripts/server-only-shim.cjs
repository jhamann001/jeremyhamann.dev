// Lets a command-line script load the app's server modules outside Next. Next resolves the `server-only` marker
// itself (it is not an installed package); here it resolves to Next's own empty build of it, for both require and
// import. Used by `npm run demo:seed`.
const Module = require("node:module");

const EMPTY = require.resolve("next/dist/compiled/server-only/empty.js");
const resolve = Module._resolveFilename;
Module._resolveFilename = function resolveServerOnly(request, ...rest) {
  return request === "server-only" ? EMPTY : resolve.call(this, request, ...rest);
};
Module.register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: ${JSON.stringify(require("node:url").pathToFileURL(EMPTY).href)}, shortCircuit: true };
  return next(specifier, context);
}`),
);
