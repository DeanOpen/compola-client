// Window-level overlays of zCloud: the item preview sheet.

import { CloudPreviewSheet } from './CloudPreviewSheet';
import { cloudUi, useCloudUi } from './support';

export function CloudHosts() {
  const preview = useCloudUi((s) => s.preview);
  return preview ? <CloudPreviewSheet key={preview.id} item={preview} onClose={() => cloudUi.preview(null)} /> : null;
}
