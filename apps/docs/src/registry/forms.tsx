// Docs entries of the "forms" group (packages/ui/src/components/forms). One ComponentDoc per component
// page, in nav order; each page lives in ./forms/<slug>.tsx. Only the forms group agent edits this file.
import { checkPresets } from './forms/check-presets';
import { checkbox } from './forms/checkbox';
import { errorSummary } from './forms/error-summary';
import { field } from './forms/field';
import { fieldInline } from './forms/field-inline';
import { fixedBar } from './forms/fixed-bar';
import { input } from './forms/input';
import { linkCards } from './forms/link-cards';
import { liveForm } from './forms/live-form';
import { picks } from './forms/picks';
import { radioCards } from './forms/radio-cards';
import { reveal } from './forms/reveal';
import { riskAcceptance } from './forms/risk-acceptance';
import { rowPicker } from './forms/row-picker';
import { select } from './forms/select';
import { stepper } from './forms/stepper';
import { submitRow } from './forms/submit-row';
import { typeCatalog } from './forms/type-catalog';
import type { ComponentDoc } from './types';

/**
 * Form controls render at the form measure, as on a form page: a `stack` example is put in a
 * `.form-layout` column (40rem) instead of stretching over the whole canvas. The type catalog and
 * link cards keep the full column, as they do in the product.
 */
function atFormWidth(doc: ComponentDoc): ComponentDoc {
  return {
    ...doc,
    examples: doc.examples.map((example) =>
      example.layout === 'stack'
        ? {
            ...example,
            render: () => (
              <div class="form-layout">
                <div class="stack-sm">{example.render()}</div>
              </div>
            ),
          }
        : example,
    ),
  };
}

export const forms: readonly ComponentDoc[] = [
  field,
  input,
  select,
  checkbox,
  radioCards,
  rowPicker,
  picks,
  checkPresets,
  fixedBar,
  reveal,
  stepper,
  liveForm,
  riskAcceptance,
  submitRow,
  errorSummary,
  typeCatalog,
  linkCards,
  fieldInline,
].map((doc) => (doc === typeCatalog || doc === linkCards ? doc : atFormWidth(doc)));
