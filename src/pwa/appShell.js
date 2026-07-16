export function removeStaticLoadingShell(doc = globalThis.document) {
  const shell = doc?.getElementById?.('app-loading')
  if (!shell) return false
  shell.remove()
  return true
}
