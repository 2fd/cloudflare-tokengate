import { htmlOf } from '../html';
// Docs entries of the "forms" group (packages/ui/src/components/forms). One ComponentDoc per component
// page, in nav order; each page lives in ./forms/<slug>.tsx. Only the forms group agent edits this file.
import { actionCards } from './forms/action-cards';
import { actionForm } from './forms/action-form';
import { checkPresets } from './forms/check-presets';
import { checkbox } from './forms/checkbox';
import { errorSummary } from './forms/error-summary';
import { field } from './forms/field';
import { fieldGrid } from './forms/field-grid';
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
import type { ComponentDoc, ComponentExample } from './types';

/**
 * Form controls render at the form measure, as on a form page: a `stack` example is put in a
 * docs-only column of the form width (`.dx-form`, 40rem) instead of stretching over the whole
 * canvas. Not the product `.form-layout`: that grid adds a summary rail column at 80rem, and a
 * LiveForm (itself a form layout) inside it would get a second, crushed rail. A LiveForm example
 * keeps the whole canvas, which holds its form column and its rail as a form page does. The type
 * catalog and link cards keep the full column, as they do in the product.
 */
function isLiveForm(example: ComponentExample): boolean {
  return htmlOf(example.render()).includes('class="lform');
}

function atFormWidth(doc: ComponentDoc): ComponentDoc {
  return {
    ...doc,
    examples: doc.examples.map((example) =>
      example.layout === 'stack' && !isLiveForm(example)
        ? {
            ...example,
            render: () => <div class="dx-form stack-sm">{example.render()}</div>,
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
  actionCards,
  rowPicker,
  picks,
  checkPresets,
  fixedBar,
  reveal,
  stepper,
  liveForm,
  riskAcceptance,
  submitRow,
  actionForm,
  errorSummary,
  typeCatalog,
  linkCards,
  fieldInline,
  fieldGrid,
].map((doc) => (doc === typeCatalog || doc === linkCards ? doc : atFormWidth(doc)));
