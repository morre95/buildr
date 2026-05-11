import * as vscode from "vscode";

export class BuildrSecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getProviderSecret(providerId: string): Promise<string | undefined> {
    return this.secrets.get(secretKey(providerId));
  }

  async storeProviderSecret(providerId: string, value: string): Promise<void> {
    await this.secrets.store(secretKey(providerId), value);
  }

  async deleteProviderSecret(providerId: string): Promise<void> {
    await this.secrets.delete(secretKey(providerId));
  }
}

function secretKey(providerId: string): string {
  return `buildr.provider.${providerId}`;
}
