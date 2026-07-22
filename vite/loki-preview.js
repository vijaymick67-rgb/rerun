export function shouldUseLokiPreviewEntry({ command, vercelEnv }) {
  return command === 'serve' || vercelEnv === 'preview'
}

export function lokiPreviewEntryPlugin(enabled) {
  return {
    name: 'loki-preview-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!enabled) return html
        return html.replace('/src/main.jsx', '/src/dev/lokiEntry.jsx')
      },
    },
  }
}
