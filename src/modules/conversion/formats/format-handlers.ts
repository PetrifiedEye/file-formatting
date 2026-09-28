import { CsvHandler } from './csv.handler';
import type { FormatHandler } from './format-handler';
import { JsonHandler } from './json.handler';
import { XmlHandler } from './xml.handler';
import { YamlHandler } from './yaml.handler';

/**
 * Every document format this service speaks — the one list both the Nest
 * module and the conversion worker threads build their registry from.
 *
 * The whole extensibility story in one place: a fifth format is one more entry
 * here and one new file. No existing handler, the controller, the DTOs, and
 * the discovery endpoint all stay untouched (FR-029).
 */
export function createFormatHandlers(): FormatHandler[] {
  return [
    new CsvHandler(),
    new JsonHandler(),
    new XmlHandler(),
    new YamlHandler(),
  ];
}
