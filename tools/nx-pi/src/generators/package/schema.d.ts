export interface PackageGeneratorSchema {
  name: string;
  description?: string;
  directory?: string;
  importPath?: string;
  repositoryUrl?: string;
  skipFormat?: boolean;
}
