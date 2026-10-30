// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * A create or add action has a `Plus` icon and is drawn by one shared
 * component in each app, `CreateButton` (`components/create-button.tsx`, the
 * CSMS and the portal copies are identical); `AddIconButton` draws the
 * icon-only form. One blue action per area (owner decision 2026-10-30): page,
 * card and tab create actions and create submits are blue (`variant` default),
 * a button that adds a row or entry inside a form is `variant="outline"`, so
 * the form's submit stays the one blue button. Green (`success`) is for
 * confirming, enabling or marking something done, never for create or add
 * (`frontend/ui.md`, "Create and add buttons"). This guard fails on a button
 * or button-styled link whose label says add, create or new and is drawn
 * outside those components, and on a `CreateButton` whose variant breaks the
 * one-blue rule.
 */

const CSMS_SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const PORTAL_SOURCES = import.meta.glob<string>(
  ['../../../../portal/src/**/*.tsx', '!**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
);

/** The shared components that draw create and add buttons. */
const SHARED_FILES = ['components/create-button.tsx', 'components/add-icon-button.tsx'];

/**
 * Create or add controls drawn by hand on purpose, as `<file>|<label>`, with
 * the reason. Keep this list short: a new entry needs a reason a reviewer
 * accepts, not a different look.
 */
const ALLOWED: Record<string, string> = {
  'components/load-management/PanelTree.tsx|loadManagement.addCircuit':
    'a ghost icon in the panel row toolbar, sized and styled like its Edit and Delete siblings',
  'components/ai/AiPanel.tsx|ai.newChat':
    'a ghost icon in the assistant panel header, styled like the other header icons',
  'components/account/AccountHomeCards.tsx|homeCards.add':
    'portal: the add icon of a home card row, styled like the other row icons',
  'pages/RoamingPartnerDetail.tsx|roaming.partners.newRegistrationToken':
    'outline exception: replaces the registration token (no Plus, nothing is added), a secondary header action next to the primary Register',
  'pages/ChargerDetail.tsx|favorites.addToFavorites':
    'portal: one state of the favorite toggle, drawn like its Remove from Favorites state',
  'pages/Register.tsx|auth.createAccount':
    'portal: the large sign-up submit of the registration page, an auth form like Sign In',
};

/**
 * `CreateButton`s that must be `variant="outline"`, as `<file>|<label>`, with
 * the reason: add-a-row controls of a form whose `<form>` element is in another
 * file (or that edit a form-like tree), and secondary adds next to a blue main
 * action. A `CreateButton` inside a `<form>` of its own file that is not the
 * submit must be outline without being listed; any other outline one must be
 * listed here.
 */
const OUTLINE: Record<string, string> = {
  'components/SchemaForm.tsx|commands.addItem': 'adds an array item inside the command form',
  'components/smart-charging/TimeSlotEditor.tsx|smartCharging.addTimeSlot':
    'adds a time slot row inside the charging profile form',
  'components/config-template/DetailsTab.tsx|configTemplates.addVariable':
    'adds a variable row inside the template edit form',
  'pages/ConfigTemplateCreate.tsx|configTemplates.addVariable':
    'adds a variable row inside the template create form',
  'components/fleet/FleetReservationsTab.tsx|fleets.addStation':
    'adds a station row inside the bulk reservation form',
  'components/load-management/PanelTree.tsx|loadManagement.addSubPanel':
    'adds a sub-panel row inside the panel tree, under the blue Add Panel of its card',
  'components/load-management/PanelTree.tsx|loadManagement.addUnmanagedLoad':
    'adds a load row inside the panel tree, under the blue Add Panel of its card',
  'pages/PricingHolidays.tsx|pricing.bulkAdd':
    'secondary header action next to the blue Add Holiday',
  'components/StationLocalAuthList.tsx|stations.addTokens':
    'secondary tab header action next to the blue Push to Station',
  'pages/ChargerDetail.tsx|stationDetail.addPaymentMethod':
    'portal: secondary to the blue Start Charging of the same screen',
};

const BUTTON_TAGS = new Set(['Button', 'button']);
const LINK_TAGS = new Set(['Link', 'NavLink', 'a']);

/** True when a translation key or an English label names a create or add action. */
export function isCreateLabel(label: string): boolean {
  if (/^(add|create|new)\b/i.test(label.trim()) && !label.includes('.')) return true;
  const last = label.split('.').pop() ?? '';
  return /^(add|create|new|bulkAdd)([A-Z0-9]|$)/.test(last);
}

/** The translation keys and plain texts a JSX subtree or attribute holds. */
function labelsOf(node: ts.Node): string[] {
  const labels: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n) && n.text.trim() !== '') labels.push(n.text.trim());
    if (ts.isStringLiteral(n) && ts.isJsxAttribute(n.parent)) labels.push(n.text);
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 't' &&
      n.arguments[0] !== undefined &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      labels.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return labels;
}

function attribute(tag: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return tag.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

/** The create or add controls a file draws by hand, as `<file>:<line> <label>`. */
export function handBuiltCreateButtons(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    const tag = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (tag !== null) {
      const name = tag.tagName.getText();
      const className = attribute(tag, 'className')?.initializer?.getText() ?? '';
      const isButton =
        BUTTON_TAGS.has(name) || (LINK_TAGS.has(name) && className.includes('buttonVariants'));
      if (isButton) {
        const labels = [
          ...(ts.isJsxElement(node) ? node.children.flatMap((c) => labelsOf(c)) : []),
          ...['aria-label', 'title'].flatMap((a) => {
            const attr = attribute(tag, a);
            return attr === undefined ? [] : labelsOf(attr);
          }),
        ];
        const label = labels.find((l) => isCreateLabel(l));
        if (label !== undefined && !(`${file}|${label}` in ALLOWED)) {
          const line = sf.getLineAndCharacterOfPosition(tag.getStart()).line + 1;
          problems.push(`${file}:${String(line)} ${label}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

/** The string value of a JSX attribute (`variant="outline"`), or undefined. */
function attributeText(tag: ts.JsxOpeningLikeElement, name: string): string | undefined {
  const init = attribute(tag, name)?.initializer;
  if (init === undefined) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (
    ts.isJsxExpression(init) &&
    init.expression !== undefined &&
    ts.isStringLiteralLike(init.expression)
  ) {
    return init.expression.text;
  }
  return init.getText();
}

/** True when a JSX element named `tag` of the same file encloses the node. */
function insideTag(node: ts.Node, tag: string): boolean {
  const found = ts.findAncestor(
    node.parent,
    (p) => ts.isJsxElement(p) && p.openingElement.tagName.getText() === tag,
  );
  return found !== undefined;
}

/**
 * `CreateButton`s whose variant breaks the one-blue rule, as
 * `<file>:<line> <label> <problem>`: an add-a-row button inside a form (or
 * listed in `outline`) that is blue, an outline one that is not listed and not
 * inside a form, and an outline submit or dialog action (a `CreateButton` in a
 * `DialogFooter` is the dialog's main action, so it is always blue).
 */
export function createButtonVariantProblems(
  file: string,
  source: string,
  outline: Record<string, string> = OUTLINE,
): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === 'CreateButton'
    ) {
      const labelAttr = attribute(node, 'label');
      const labels = labelAttr === undefined ? [] : labelsOf(labelAttr);
      const label = labels.find((l) => isCreateLabel(l)) ?? labels[0] ?? '';
      const isOutline = attributeText(node, 'variant') === 'outline';
      const isSubmit = attributeText(node, 'type') === 'submit' || insideTag(node, 'DialogFooter');
      // A submit or dialog action is never an add-a-row control, even when it shares the label.
      const listed = `${file}|${label}` in outline && !isSubmit;
      const inForm = insideTag(node, 'form') && !isSubmit;
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const at = `${file}:${String(line)} ${label}`;
      if (isSubmit && isOutline) problems.push(`${at} submit must be blue`);
      else if ((listed || inForm) && !isOutline) problems.push(`${at} must be outline`);
      else if (isOutline && !listed && !inForm) problems.push(`${at} must be blue`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

/** Strips the glob prefix so both apps report `components/...` and `pages/...`. */
function relative(path: string): string {
  return path.replace(/^(\.\.\/)+(portal\/src\/)?/, '');
}

function scan(sources: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    const file = relative(path);
    if (SHARED_FILES.includes(file)) continue;
    problems.push(...handBuiltCreateButtons(file, source));
  }
  return problems;
}

/** Exported `Add*`, `Create*` or `New*` button components other than the shared ones. */
function otherCreateComponents(sources: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/export function ((?:Add|Create|New)\w*Button)\b/g)) {
      const name = match[1] ?? '';
      if (name !== 'CreateButton' && name !== 'AddIconButton') {
        found.push(`${relative(path)} ${name}`);
      }
    }
  }
  return found;
}

function sourceOf(sources: Record<string, string>, file: string): string {
  const entry = Object.entries(sources).find(([path]) => relative(path) === file);
  if (entry === undefined) throw new Error(`missing ${file}`);
  return entry[1];
}

describe('create and add buttons', () => {
  it('draws every CSMS create or add button with the shared component', () => {
    expect(scan(CSMS_SOURCES)).toEqual([]);
  });

  it('draws every portal create or add button with the shared component', () => {
    expect(scan(PORTAL_SOURCES)).toEqual([]);
  });

  it('has no other shared create or add button component', () => {
    expect(otherCreateComponents(CSMS_SOURCES)).toEqual([]);
    expect(otherCreateComponents(PORTAL_SOURCES)).toEqual([]);
  });

  it('keeps the CSMS and portal CreateButton identical, blue by default, outline only, with a Plus icon', () => {
    const csms = sourceOf(CSMS_SOURCES, 'components/create-button.tsx');
    expect(sourceOf(PORTAL_SOURCES, 'components/create-button.tsx')).toBe(csms);
    expect(csms).toMatch(/variant\?: 'default' \| 'outline';/);
    expect(csms).toMatch(/variant = 'default',/);
    expect(csms).toMatch(/<Plus\b/);
  });

  it('draws add-a-row buttons inside forms in outline and every other create action in blue', () => {
    const problems: string[] = [];
    for (const sources of [CSMS_SOURCES, PORTAL_SOURCES]) {
      for (const [path, source] of Object.entries(sources)) {
        const file = relative(path);
        if (SHARED_FILES.includes(file)) continue;
        problems.push(...createButtonVariantProblems(file, source));
      }
    }
    expect(problems).toEqual([]);
  });

  it('flags a blue add-a-row button, an unlisted outline create and an outline submit', () => {
    const source = [
      '<form onSubmit={submit}>',
      "  <CreateButton label={t('commands.addItem')} onClick={add} />",
      '  <CreateButton label={t(\'configTemplates.addVariable\')} variant="outline" onClick={add} />',
      '  <CreateButton type="submit" variant="outline" label={t(\'common.create\')} />',
      '  <CreateButton type="submit" label={t(\'common.create\')} />',
      '</form>;',
      'const a = <CreateButton label={t(\'sites.addSite\')} variant="outline" onClick={add} />;',
      "const b = <CreateButton label={t('sites.addSite')} onClick={add} />;",
      "const c = <CreateButton label={t('pricing.bulkAdd')} onClick={add} />;",
      'const d = <CreateButton label={t(\'pricing.bulkAdd\')} variant="outline" onClick={add} />;',
      "const e = <DialogFooter><CreateButton label={t('pricing.bulkAdd')} /></DialogFooter>;",
      'const f = <DialogFooter><CreateButton label={t(\'sites.addSite\')} variant="outline" /></DialogFooter>;',
    ].join('\n');
    expect(
      createButtonVariantProblems('sample.tsx', source, { 'sample.tsx|pricing.bulkAdd': 'test' }),
    ).toEqual([
      'sample.tsx:2 commands.addItem must be outline',
      'sample.tsx:4 common.create submit must be blue',
      'sample.tsx:7 sites.addSite must be blue',
      'sample.tsx:9 pricing.bulkAdd must be outline',
      'sample.tsx:12 sites.addSite submit must be blue',
    ]);
  });

  it('keeps every outline entry in use', () => {
    const problems: string[] = [];
    for (const key of Object.keys(OUTLINE)) {
      const [file = '', label = ''] = key.split('|');
      const inCsms = Object.keys(CSMS_SOURCES).some((p) => relative(p) === file);
      const source = sourceOf(inCsms ? CSMS_SOURCES : PORTAL_SOURCES, file);
      if (!source.includes(`'${label}'`)) problems.push(key);
    }
    expect(problems).toEqual([]);
  });

  it('keeps every allowed exception in use', () => {
    const problems: string[] = [];
    for (const key of Object.keys(ALLOWED)) {
      const [file = '', label = ''] = key.split('|');
      const inCsms = Object.keys(CSMS_SOURCES).some((p) => relative(p) === file);
      const source = sourceOf(inCsms ? CSMS_SOURCES : PORTAL_SOURCES, file);
      if (!source.includes(`'${label}'`)) problems.push(key);
    }
    expect(problems).toEqual([]);
  });

  it('flags green, outline and link create buttons drawn by hand', () => {
    const source = [
      'const a = <Button variant="success" onClick={add}><Plus />{t(\'drivers.addDriver\')}</Button>;',
      'const b = <Button variant="outline">{t(\'commands.addItem\')}</Button>;',
      'const c = <Link to="/x/new" className={buttonVariants()}>{t(\'sites.createSite\')}</Link>;',
      'const d = <Button aria-label="New Chat" size="icon"><Plus /></Button>;',
      "const e = <Button>{t('common.save')}</Button>;",
      'const f = <Link to="/x/new">{t(\'sites.createSite\')}</Link>;',
      "const g = <CreateButton label={t('drivers.addDriver')} onClick={add} />;",
    ].join('\n');
    expect(handBuiltCreateButtons('sample.tsx', source)).toEqual([
      'sample.tsx:1 drivers.addDriver',
      'sample.tsx:2 commands.addItem',
      'sample.tsx:3 sites.createSite',
      'sample.tsx:4 New Chat',
    ]);
  });

  it('reads add, create and new labels', () => {
    expect(isCreateLabel('fleets.addStation')).toBe(true);
    expect(isCreateLabel('settings.createApiKey')).toBe(true);
    expect(isCreateLabel('ai.newChat')).toBe(true);
    expect(isCreateLabel('pricing.bulkAdd')).toBe(true);
    expect(isCreateLabel('common.create')).toBe(true);
    expect(isCreateLabel('Add Rule')).toBe(true);
    expect(isCreateLabel('stations.addressLine')).toBe(false);
    expect(isCreateLabel('common.newest')).toBe(false);
    expect(isCreateLabel('common.save')).toBe(false);
  });
});
