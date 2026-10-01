export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Try a directory index next.
    }
    try {
      return await next(`${specifier}/index.ts`, context);
    } catch {
      // Fall through to the default resolution error.
    }
  }
  return next(specifier, context);
}
