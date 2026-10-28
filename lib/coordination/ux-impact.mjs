/** Conservative path-level signal. Content and ambiguous helpers need human review. */
export function classifyAdminUxImpact(paths) {
  const visible = [];
  const internal = [];
  const review = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!path.startsWith('apps/admin/')) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
      || path.startsWith('apps/admin/e2e/')
      || path.startsWith('apps/admin/app/api/')
      || /\.(?:d\.ts|types?\.ts)$/.test(path)) {
      internal.push(path);
    } else if (/\.(?:css|scss)$/.test(path)
      || /^apps\/admin\/(?:lib|src\/lib)\/(?:i18n|messages|copy|translations)(?:\/|\.)/.test(path)
      || /^apps\/admin\/app\/(?!api\/).*\/(?:page|layout|loading|error|not-found)\.[jt]sx$/.test(path)
      || /^apps\/admin\/app\/(?:page|layout|loading|error|not-found)\.[jt]sx$/.test(path)
      || /^apps\/admin\/(?:components|src\/components)\/.*\.[jt]sx$/.test(path)
      || path.startsWith('apps/admin/public/')) {
      visible.push(path);
    } else {
      review.push(path);
    }
  }
  return { visible, internal, review };
}
