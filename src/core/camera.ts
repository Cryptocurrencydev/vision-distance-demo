/** Front-camera access. The MediaStream is only ever attached to a local <video>; frames are
 * read by on-device inference and never encoded, uploaded or persisted. */

export interface CameraHandle {
  stream: MediaStream;
  video: HTMLVideoElement;
  label: string;
  width: number;
  height: number;
  stop(): void;
}

export class CameraError extends Error {
  constructor(public kind: 'unsupported' | 'denied' | 'notfound' | 'insecure' | 'other', msg: string) {
    super(msg);
  }
}

export async function openFrontCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  if (!window.isSecureContext) throw new CameraError('insecure', 'Camera needs HTTPS.');
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('unsupported', 'This browser cannot access the camera.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        // 720p is plenty: at 40 cm the iris spans ~25–30 px. Higher costs bandwidth for nothing.
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('denied', 'Camera permission was denied.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('notfound', 'No front camera was found.');
    }
    throw new CameraError('other', (e as Error)?.message || 'Could not start the camera.');
  }

  video.setAttribute('playsinline', ''); // iOS: no fullscreen takeover
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  if (video.readyState < 2) {
    await new Promise<void>((res) => video.addEventListener('loadeddata', () => res(), { once: true }));
  }
  const track = stream.getVideoTracks()[0];
  return {
    stream,
    video,
    label: track?.label ?? '',
    width: video.videoWidth,
    height: video.videoHeight,
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
