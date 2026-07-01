export interface PromptGeneratorSchema {
  name: string;
  project: string;
  description?: string;
  argumentHint?: string;
  overwrite?: boolean;
  skipFormat?: boolean;
}
