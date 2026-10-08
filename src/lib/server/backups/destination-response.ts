export interface EditableDestinationValues {
	envVars: Record<string, string>;
	sshKnownHosts: string | null;
}

export function prepareBackupDestinationResponse(
	destination: any,
	editableValues?: EditableDestinationValues
): any {
	const result = { ...destination };
	delete result.password;

	if (editableValues) {
		result.envVars = editableValues.envVars;
		result.sshKnownHosts = editableValues.sshKnownHosts;
	} else {
		delete result.envVars;
		delete result.sshKnownHosts;
	}

	result.hasCacert = !!destination.cacert;
	result.hasTlsClientCert = !!destination.tlsClientCert;
	result.hasSshPrivateKey = !!destination.sshPrivateKey;
	result.hasSshKnownHosts = !!destination.sshKnownHosts;
	delete result.cacert;
	delete result.tlsClientCert;
	delete result.sshPrivateKey;
	return result;
}
