export const knowledgeFileTypes = '.pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp';
export function knowledgeFileError(files) {
  if (files.length !== 1) return 'Choose one file to upload.';
  const file = files[0];
  if (!file.size || file.size > 20 * 1024 * 1024) return 'Choose a non-empty file up to 20 MB.';
  if (!/\.(pdf|docx|pptx|png|jpg|jpeg|webp)$/i.test(file.name))
    return 'Use PDF, DOCX, PPTX, PNG, JPEG or WebP.';
  return '';
}
export function knowledgeFilePickerHtml() {
  return `<div id="ks-picker" class="ks-picker">
    <div class="ks-drop-zone" id="ks-drop-zone">
      <p id="ks-drop-label">Drag and drop one file here</p>
      <button type="button" class="btn" data-action="ks.choose" aria-describedby="ks-file-help ks-file-error">Choose file</button>
      <input id="ks-file" type="file" accept="${knowledgeFileTypes}" hidden>
      <p id="ks-file-selection" role="status">No file selected</p>
    </div>
    <p id="ks-file-help">PDF, Word (.docx), PowerPoint (.pptx) or image. Up to 20 MB and 30 PDF pages or slides. OCR supports English and Spanish.</p>
    <p id="ks-file-error" class="ks-file-error" role="alert"></p>
  </div>`;
}
export function attachKnowledgeFilePicker(root) {
  const input = root.querySelector('#ks-file');
  const zone = root.querySelector('#ks-drop-zone');
  const button = root.querySelector('[data-action="ks.choose"]');
  const selection = root.querySelector('#ks-file-selection');
  const error = root.querySelector('#ks-file-error');
  const label = root.querySelector('#ks-drop-label');
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let selected = null, locked = false, depth = 0;
  const active = () => root.isConnected;
  const resetDrag = () => {
    depth = 0;
    zone.classList.remove('is-dragging');
    label.textContent = 'Drag and drop one file here';
  };
  const showError = (message) => {
    error.textContent = message;
    button.setAttribute('aria-invalid', message ? 'true' : 'false');
  };
  const choose = (files) => {
    if (!active() || locked) return;
    const message = knowledgeFileError(files);
    // A rejected drop clears the previous selection to avoid uploading the wrong file.
    selected = message ? null : files[0];
    input.value = '';
    selection.textContent = selected ? `${selected.name} (${(selected.size / 1024 / 1024).toFixed(2)} MB)` : 'No file selected';
    showError(message);
  };
  const fileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  input.addEventListener('change', () => { if (input.files.length) choose(Array.from(input.files)); }, options);
  zone.addEventListener('dragenter', (event) => {
    if (!fileDrag(event) || locked) return;
    event.preventDefault(); depth++;
    zone.classList.add('is-dragging'); label.textContent = 'Drop file to select it';
  }, options);
  zone.addEventListener('dragleave', () => { if (--depth <= 0) resetDrag(); }, options);
  zone.addEventListener('dragover', (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = locked ? 'none' : 'copy';
  }, options);
  zone.addEventListener('drop', (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault(); resetDrag(); choose(Array.from(event.dataTransfer.files));
  }, options);
  // While this dialog is open, dropping outside the target must not navigate away.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (event) => {
    if (active() && fileDrag(event)) event.preventDefault();
  }, options);
  const observer = new MutationObserver(() => {
    if (!active()) { controller.abort(); observer.disconnect(); }
  });
  observer.observe(root.parentNode, { childList: true, subtree: true });
  // The modal body itself is removed on close, so observe the stable modal host too.
  observer.observe(document.getElementById('modal-container'), { childList: true, subtree: true });
  return {
    getFile() {
      if (!selected) { showError('Choose one file to upload.'); button.focus(); }
      return selected;
    },
    setBusy(value) {
      locked = value; button.disabled = value; input.disabled = value;
      root.setAttribute('aria-busy', String(value)); resetDrag();
    },
    isActive: active,
  };
}
