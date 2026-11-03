/** localStorage wrapper — every access is guarded (private mode, blocked storage, quota). */

const STORAGE_NAME = 'iriscale.v1.calibration';

export interface Calibration {
  /** focal length normalised to the long side of the video frame */
  focalNorm: number | null;
  focalSource: 'default' | 'known-distance';
  /** personal horizontal visible iris diameter, mm */
  irisMm: number | null;
  irisSource: 'population' | 'card';
  /** CSS px per mm of this screen */
  ppmm: number | null;
  ppmmSource: 'default' | 'card';
  /** camera label the focal length belongs to (front vs. back / external cams differ) */
  cameraLabel: string;
  updatedAt: string;
}

export const EMPTY_CALIBRATION: Calibration = {
  focalNorm: null, focalSource: 'default',
  irisMm: null, irisSource: 'population',
  ppmm: null, ppmmSource: 'default',
  cameraLabel: '', updatedAt: '',
};

export function loadCalibration(): Calibration {
  try {
    const raw = window.localStorage.getItem(STORAGE_NAME);
    if (!raw) return { ...EMPTY_CALIBRATION };
    const parsed = JSON.parse(raw) as Partial<Calibration>;
    return { ...EMPTY_CALIBRATION, ...parsed };
  } catch {
    return { ...EMPTY_CALIBRATION };
  }
}

export function saveCalibration(c: Calibration): boolean {
  try {
    window.localStorage.setItem(STORAGE_NAME, JSON.stringify({ ...c, updatedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function clearCalibration(): void {
  try { window.localStorage.removeItem(STORAGE_NAME); } catch { /* storage unavailable */ }
}
