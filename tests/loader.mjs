export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/lib/auth.ts") || specifier === "../lib/auth")
    return {
      url: new URL("./auth-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (
    context.parentURL?.includes("/backend/platform") &&
    (specifier === "./store" || specifier.endsWith("/backend/store.ts"))
  )
    return {
      url: new URL("./store-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith("/lib/auth.ts"))
    return {
      url: new URL("./auth-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (
    resolved.url.endsWith("/backend/store.ts") &&
    context.parentURL?.includes("/backend/platform")
  )
    return {
      url: new URL("./store-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  return resolved;
}
