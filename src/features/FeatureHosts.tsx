// Window-level overlays of the feature waves (sheets, banners, viewers), rendered once by the main shell.

import { CallHosts } from './calls/hosts';
import { CardHosts } from './cardSheets/hosts';
import { CloudHosts } from './cloud/hosts';
import { ContactsHosts } from './contacts/hosts';
import { MediaHosts } from './media/hosts';
import { SettingsHosts } from './settings/hosts';
import { TransferHosts } from './transfer/hosts';

export function FeatureHosts() {
  return (
    <>
      <ContactsHosts />
      <CloudHosts />
      <CardHosts />
      <TransferHosts />
      <SettingsHosts />
      <MediaHosts />
      <CallHosts />
    </>
  );
}
