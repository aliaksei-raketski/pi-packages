export interface SkillGeneratorSchema {
  name: string;
  project: string;
  description?: string;
  overwrite?: boolean;
  skipFormat?: boolean;
}
