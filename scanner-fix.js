/* Correctif de cadrage V2 : aligne l'image analysée sur le guide visible. */
function getDisplayedVideoCrop(video, guide) {
  const videoRect = video.getBoundingClientRect();
  const guideRect = guide.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const displayRatio = videoRect.width / videoRect.height;
  const videoRatio = vw / vh;

  let renderedWidth;
  let renderedHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (videoRatio > displayRatio) {
    renderedHeight = videoRect.height;
    renderedWidth = renderedHeight * videoRatio;
    offsetX = (renderedWidth - videoRect.width) / 2;
  } else {
    renderedWidth = videoRect.width;
    renderedHeight = renderedWidth / videoRatio;
    offsetY = (renderedHeight - videoRect.height) / 2;
  }

  const relativeLeft = guideRect.left - videoRect.left + offsetX;
  const relativeTop = guideRect.top - videoRect.top + offsetY;

  return {
    sx: Math.max(0, relativeLeft / renderedWidth * vw),
    sy: Math.max(0, relativeTop / renderedHeight * vh),
    sw: Math.min(vw, guideRect.width / renderedWidth * vw),
    sh: Math.min(vh, guideRect.height / renderedHeight * vh)
  };
}

captureFullCard = function captureGuidedCard() {
  const video = els.cameraVideo;
  const guide = document.querySelector('.card-guide');
  if (!video.videoWidth || !video.videoHeight || !guide) return null;

  const crop = getDisplayedVideoCrop(video, guide);
  const canvas = els.captureCanvas;
  canvas.width = 630;
  canvas.height = 880;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
  return canvas;
};

function adaptiveTextRegion(source, x, y, w, h, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.filter = 'grayscale(1) contrast(2.5) brightness(1.15)';
  ctx.drawImage(source, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

recognizeFrame = async function recognizeGuidedFrame(canvas) {
  const w = canvas.width;
  const h = canvas.height;

  // Zones réelles d'une carte Magic après recadrage sur le guide.
  const titleRegion = adaptiveTextRegion(canvas, w * 0.075, h * 0.035, w * 0.78, h * 0.095, 3.2);
  const collectorRegion = adaptiveTextRegion(canvas, w * 0.47, h * 0.875, w * 0.46, h * 0.085, 3.4);

  const [titleResult, collectorResult] = await Promise.all([
    Tesseract.recognize(titleRegion, 'fra+eng', {
      tessedit_pageseg_mode: 7,
      preserve_interword_spaces: '1'
    }),
    Tesseract.recognize(collectorRegion, 'eng', {
      tessedit_pageseg_mode: 7,
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/'
    })
  ]);

  return extractSignals(titleResult.data.text, collectorResult.data.text);
};

cropObservedArt = function cropGuidedArtwork(frame) {
  const w = frame.width;
  const h = frame.height;
  return makeRegion(frame, w * 0.095, h * 0.155, w * 0.81, h * 0.37, 0.55, 'none');
};