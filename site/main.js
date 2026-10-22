const copyButton = document.querySelector('[data-copy-prompt]')
const prompt = document.querySelector('#agent-prompt')
const copyStatus = document.querySelector('.copy-status')

if (copyButton && prompt && copyStatus && navigator.clipboard?.writeText) {
  copyButton.hidden = false
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(prompt.textContent.trim())
      copyButton.textContent = 'Copied ✓'
      copyStatus.textContent = 'Starting prompt copied to clipboard.'
    } catch {
      copyStatus.textContent = 'Copy unavailable. Select and copy the starting prompt.'
    }
  })
}
