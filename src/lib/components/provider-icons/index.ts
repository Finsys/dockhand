import type { IconComponent } from '$lib/types';
import { KeyRound } from 'lucide-svelte';
import OnePassword from './OnePassword.svelte';
import Infisical from './Infisical.svelte';
import HashiCorpVault from './HashiCorpVault.svelte';
import Doppler from './Doppler.svelte';
import Bitwarden from './Bitwarden.svelte';
import ProtonPass from './ProtonPass.svelte';
import AzureKeyVault from './AzureKeyVault.svelte';
import KeePassXC from './KeePassXC.svelte';
import Psono from './Psono.svelte';

/** Brand icon for a secret-provider type. Falls back to a generic key icon. */
export function getProviderIcon(type: string): IconComponent {
	switch (type) {
		case 'op-service-account':
		case 'op-connect':
			return OnePassword;
		case 'infisical':
			return Infisical;
		case 'vault':
			return HashiCorpVault;
		case 'doppler':
			return Doppler;
		case 'bitwarden':
			return Bitwarden;
		case 'proton':
			return ProtonPass;
		case 'azure-kv':
			return AzureKeyVault;
		case 'keepass':
			return KeePassXC;
		case 'psono':
			return Psono;
		default:
			return KeyRound; // any future provider until it has a brand icon
	}
}
