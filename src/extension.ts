import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// tag parsing per Instructions.md rules

const NAME = '[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?';
const VALUE = '[A-Za-z0-9=_\\- ]*';
const OPEN_RE = new RegExp(`<(${NAME})((?: +${NAME}(?:="${VALUE}")?)*)>`, 'y');
const CLOSE_RE = new RegExp(`</(${NAME})>`, 'y');
const ATTR_RE = new RegExp(`( +)(${NAME})(?:(=)("${VALUE}"))?`, 'g');

interface Span { line: number; start: number; end: number; }

interface AttrSpan { name: Span; eq?: Span; value?: Span; }

interface Tag {
    kind: 'open' | 'close';
    name: string;
    span: Span;
    head: Span;
    tail: Span;
    attrs: AttrSpan[];
    depth: number;
    pair: number;
    invalid: boolean;
    reason?: string;
}

interface CodeBlock { startLine: number; endLine: number; }

interface ParseResult {
    tags: Tag[];
    codeBlocks: CodeBlock[];
    inlineCode: Span[];
}

// inline code spans: a backtick run closed by a run of the same length on the same line
function findInlineCode(line: string, lineNo: number): Span[] {
    const spans: Span[] = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] !== '`') { i++; continue; }
        const runStart = i;
        while (i < line.length && line[i] === '`') i++;
        const runLen = i - runStart;
        let j = i;
        let close = -1;
        while (j < line.length) {
            if (line[j] === '`') {
                const s = j;
                while (j < line.length && line[j] === '`') j++;
                if (j - s === runLen) { close = s; break; }
            } else {
                j++;
            }
        }
        if (close >= 0) {
            spans.push({ line: lineNo, start: runStart, end: close + runLen });
            i = close + runLen;
        } else {
            i = runStart + runLen;
        }
    }
    return spans;
}

function inSpan(spans: Span[], pos: number): Span | undefined {
    return spans.find(s => pos >= s.start && pos < s.end);
}

function scanTags(line: string, lineNo: number, codeSpans: Span[], tags: Tag[]): void {
    let pos = 0;
    let lastTagEnd = 0;
    while (pos < line.length) {
        const code = inSpan(codeSpans, pos);
        if (code) { pos = code.end; continue; }
        if (line[pos] !== '<') { pos++; continue; }

        if (line.startsWith('</', pos)) {
            CLOSE_RE.lastIndex = pos;
            const m = CLOSE_RE.exec(line);
            if (m) {
                tags.push({
                    kind: 'close', name: m[1],
                    span: { line: lineNo, start: pos, end: pos + m[0].length },
                    head: { line: lineNo, start: pos, end: pos + 2 + m[1].length },
                    tail: { line: lineNo, start: pos + m[0].length - 1, end: pos + m[0].length },
                    attrs: [], depth: 0, pair: -1, invalid: false
                });
                lastTagEnd = pos + m[0].length;
                pos = lastTagEnd;
                continue;
            }
            pos += 2;
            continue;
        }

        OPEN_RE.lastIndex = pos;
        const m = OPEN_RE.exec(line);
        // opening tag only valid when preceded by whitespace or another tag
        if (m && /^\s*$/.test(line.slice(lastTagEnd, pos))) {
            const attrs: AttrSpan[] = [];
            const attrsOffset = pos + 1 + m[1].length;
            ATTR_RE.lastIndex = 0;
            let am: RegExpExecArray | null;
            while ((am = ATTR_RE.exec(m[2])) !== null) {
                const base = attrsOffset + am.index + am[1].length;
                const attr: AttrSpan = { name: { line: lineNo, start: base, end: base + am[2].length } };
                if (am[3]) {
                    attr.eq = { line: lineNo, start: base + am[2].length, end: base + am[2].length + 1 };
                    attr.value = { line: lineNo, start: attr.eq.end, end: attr.eq.end + am[4].length };
                }
                attrs.push(attr);
            }
            tags.push({
                kind: 'open', name: m[1],
                span: { line: lineNo, start: pos, end: pos + m[0].length },
                head: { line: lineNo, start: pos, end: pos + 1 + m[1].length },
                tail: { line: lineNo, start: pos + m[0].length - 1, end: pos + m[0].length },
                attrs, depth: 0, pair: -1, invalid: false
            });
            lastTagEnd = pos + m[0].length;
            pos = lastTagEnd;
            continue;
        }
        pos++;
    }
}

// stack matching: crossing tags (open a, open b, close a, close b) flag b as invalid
function matchTags(tags: Tag[]): void {
    const stack: number[] = [];
    for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t.kind === 'open') {
            t.depth = stack.length;
            stack.push(i);
            continue;
        }
        if (stack.length && tags[stack[stack.length - 1]].name === t.name) {
            const oi = stack.pop()!;
            tags[oi].pair = i;
            t.pair = oi;
            t.depth = tags[oi].depth;
            continue;
        }
        let found = -1;
        for (let j = stack.length - 1; j >= 0; j--) {
            if (tags[stack[j]].name === t.name) { found = j; break; }
        }
        if (found >= 0) {
            for (let j = stack.length - 1; j > found; j--) {
                tags[stack[j]].invalid = true;
                tags[stack[j]].reason = `Tag <${tags[stack[j]].name}> is not closed before </${t.name}>`;
            }
            const oi = stack[found];
            stack.length = found;
            tags[oi].pair = i;
            t.pair = oi;
            t.depth = tags[oi].depth;
        } else {
            t.invalid = true;
            t.reason = `No matching opening tag for </${t.name}>`;
        }
    }
    for (const j of stack) {
        tags[j].invalid = true;
        tags[j].reason = `Tag <${tags[j].name}> is never closed`;
    }
}

function parseDocument(lines: string[]): ParseResult {
    const tags: Tag[] = [];
    const codeBlocks: CodeBlock[] = [];
    const inlineCode: Span[] = [];

    let fenceLine = -1;
    let fenceMarker = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = line.match(/^\s*(`{3,}|~{3,})/);
        if (fenceLine >= 0) {
            if (fence && fence[1][0] === fenceMarker[0] && fence[1].length >= fenceMarker.length && /^\s*(`{3,}|~{3,})\s*$/.test(line)) {
                codeBlocks.push({ startLine: fenceLine, endLine: i });
                fenceLine = -1;
            }
            continue;
        }
        if (fence) {
            fenceLine = i;
            fenceMarker = fence[1];
            continue;
        }
        const codeSpans = findInlineCode(line, i);
        inlineCode.push(...codeSpans);
        scanTags(line, i, codeSpans, tags);
    }
    if (fenceLine >= 0) {
        codeBlocks.push({ startLine: fenceLine, endLine: lines.length - 1 });
    }
    matchTags(tags);
    return { tags, codeBlocks, inlineCode };
}

// parse cache keyed by document version

const parseCache = new Map<string, { version: number; result: ParseResult }>();

function getParse(document: vscode.TextDocument): ParseResult {
    const key = document.uri.toString();
    const cached = parseCache.get(key);
    if (cached && cached.version === document.version) return cached.result;
    const result = parseDocument(document.getText().split(/\r?\n/));
    parseCache.set(key, { version: document.version, result });
    return result;
}

function isClaudeMd(document: vscode.TextDocument): boolean {
    if (document.languageId === 'claudemd') return true;
    return /^(claude|agent)\.md$/i.test(path.basename(document.fileName));
}

function spanRange(s: Span): vscode.Range {
    return new vscode.Range(s.line, s.start, s.line, s.end);
}

// decorations

interface DecoTypes {
    tagDepth: vscode.TextEditorDecorationType[];
    attrName: vscode.TextEditorDecorationType;
    attrValue: vscode.TextEditorDecorationType;
    codeBlock: vscode.TextEditorDecorationType;
    inlineCode: vscode.TextEditorDecorationType;
    invalid: vscode.TextEditorDecorationType;
    colorCode: boolean;
}

let decoTypes: DecoTypes | undefined;
let pairDeco: vscode.TextEditorDecorationType | undefined;

function createDecoTypes(): DecoTypes {
    const cfg = vscode.workspace.getConfiguration('claudemd');
    const palette = cfg.get<string[]>('tagColors', ['#10f500', '#b900de', '#A9DC76', '#AB9DF2', '#FFD866', '#FC9867']);
    const colors = palette.length ? palette : ['#FF6188'];
    return {
        tagDepth: colors.map(c => vscode.window.createTextEditorDecorationType({ color: c })),
        attrName: vscode.window.createTextEditorDecorationType({ color: cfg.get<string>('attributeNameColor', '#FFA657') }),
        attrValue: vscode.window.createTextEditorDecorationType({ color: cfg.get<string>('attributeValueColor', '#C3E88D') }),
        codeBlock: vscode.window.createTextEditorDecorationType({ color: cfg.get<string>('codeBlockColor', '#CE9178') }),
        inlineCode: vscode.window.createTextEditorDecorationType({ color: cfg.get<string>('inlineCodeColor', '#D7BA7D') }),
        invalid: vscode.window.createTextEditorDecorationType({ color: cfg.get<string>('invalidTagColor', '#F44747') }),
        colorCode: cfg.get<boolean>('colorCodeBlocks', true)
    };
}

function disposeDecoTypes(): void {
    if (!decoTypes) return;
    decoTypes.tagDepth.forEach(d => d.dispose());
    decoTypes.attrName.dispose();
    decoTypes.attrValue.dispose();
    decoTypes.codeBlock.dispose();
    decoTypes.inlineCode.dispose();
    decoTypes.invalid.dispose();
    decoTypes = undefined;
}

function updateDecorations(editor: vscode.TextEditor): void {
    if (!decoTypes || !isClaudeMd(editor.document)) return;
    const result = getParse(editor.document);
    const types = decoTypes;

    const byDepth: vscode.Range[][] = types.tagDepth.map(() => []);
    const attrNameRanges: vscode.Range[] = [];
    const attrValueRanges: vscode.Range[] = [];
    const invalidRanges: vscode.Range[] = [];

    for (const t of result.tags) {
        if (t.invalid) {
            invalidRanges.push(spanRange(t.span));
            continue;
        }
        const bucket = t.depth % types.tagDepth.length;
        byDepth[bucket].push(spanRange(t.head), spanRange(t.tail));
        for (const a of t.attrs) {
            attrNameRanges.push(spanRange(a.name));
            if (a.eq) attrNameRanges.push(spanRange(a.eq));
            if (a.value) attrValueRanges.push(spanRange(a.value));
        }
    }

    types.tagDepth.forEach((deco, i) => editor.setDecorations(deco, byDepth[i]));
    editor.setDecorations(types.attrName, attrNameRanges);
    editor.setDecorations(types.attrValue, attrValueRanges);
    editor.setDecorations(types.invalid, invalidRanges);

    if (types.colorCode) {
        const codeRanges = result.codeBlocks.map(b =>
            new vscode.Range(b.startLine, 0, b.endLine, editor.document.lineAt(b.endLine).text.length));
        editor.setDecorations(types.codeBlock, codeRanges);
        editor.setDecorations(types.inlineCode, result.inlineCode.map(spanRange));
    } else {
        editor.setDecorations(types.codeBlock, []);
        editor.setDecorations(types.inlineCode, []);
    }
}

// pair highlight when cursor sits on a tag

function updatePairHighlight(editor: vscode.TextEditor): void {
    if (!pairDeco || !isClaudeMd(editor.document)) return;
    const result = getParse(editor.document);
    const pos = editor.selection.active;
    const hit = result.tags.find(t =>
        t.span.line === pos.line && pos.character >= t.span.start && pos.character <= t.span.end);
    const ranges: vscode.Range[] = [];
    if (hit && hit.pair >= 0) {
        ranges.push(spanRange(hit.span), spanRange(result.tags[hit.pair].span));
    }
    editor.setDecorations(pairDeco, ranges);
}

// diagnostics for invalid tags

const diagCollection = vscode.languages.createDiagnosticCollection('claudemd');

function updateDiagnostics(document: vscode.TextDocument): void {
    if (!isClaudeMd(document)) {
        diagCollection.delete(document.uri);
        return;
    }
    const result = getParse(document);
    const diags = result.tags
        .filter(t => t.invalid)
        .map(t => new vscode.Diagnostic(spanRange(t.span), t.reason ?? 'Invalid tag', vscode.DiagnosticSeverity.Warning));
    diagCollection.set(document.uri, diags);
}

// folding

class ClaudeMdFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        const result = getParse(document);
        const ranges: vscode.FoldingRange[] = [];

        for (const t of result.tags) {
            if (t.kind === 'open' && t.pair >= 0) {
                const close = result.tags[t.pair];
                if (close.span.line > t.span.line) {
                    ranges.push(new vscode.FoldingRange(t.span.line, close.span.line, vscode.FoldingRangeKind.Region));
                }
            }
        }

        for (const b of result.codeBlocks) {
            if (b.endLine > b.startLine) {
                ranges.push(new vscode.FoldingRange(b.startLine, b.endLine, vscode.FoldingRangeKind.Region));
            }
        }

        const codeLines = new Set<number>();
        result.codeBlocks.forEach(b => { for (let l = b.startLine; l <= b.endLine; l++) codeLines.add(l); });

        const lines = document.getText().split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (codeLines.has(i)) continue;
            const header = lines[i].match(/^(#{1,6})\s+/);
            if (!header) continue;
            const level = header[1].length;
            let end = -1;
            for (let j = i + 1; j < lines.length; j++) {
                if (codeLines.has(j)) continue;
                const next = lines[j].match(/^(#{1,6})\s+/);
                if (next && next[1].length <= level) { end = j - 1; break; }
                if (j === lines.length - 1) end = j;
            }
            if (end > i) ranges.push(new vscode.FoldingRange(i, end, vscode.FoldingRangeKind.Region));
        }

        return ranges;
    }
}

// conversion to standard markdown for preview

interface TagInfo {
    name: string;
    attributes: string;
    depth: number;
}

function convertClaudeMdToMarkdown(text: string): string {
    const lines = text.split(/\r?\n/);
    const output: string[] = [];

    let inFencedCodeBlock = false;
    let fenceChar = '';
    let fenceLength = 0;
    const tagStack: TagInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
        if (fenceMatch) {
            if (!inFencedCodeBlock) {
                inFencedCodeBlock = true;
                fenceChar = fenceMatch[2][0];
                fenceLength = fenceMatch[2].length;
                output.push(line);
                continue;
            } else {
                const closingMatch = line.match(new RegExp(`^\\s*${fenceChar}{${fenceLength},}\\s*$`));
                if (closingMatch) {
                    inFencedCodeBlock = false;
                    output.push(line);
                    continue;
                }
            }
        }

        if (inFencedCodeBlock) {
            output.push(line);
            continue;
        }

        const processedLine = processLine(line, tagStack);
        if (processedLine !== null) {
            output.push(processedLine);
        }
    }

    return output.join('\n');
}

function processLine(line: string, tagStack: TagInfo[]): string | null {
    const trimmed = line.trim();

    if (trimmed === '') {
        return '';
    }

    const standaloneClosingMatch = trimmed.match(/^<\/([a-zA-Z0-9][a-zA-Z0-9_-]*)>\s*$/);
    if (standaloneClosingMatch) {
        const tagName = standaloneClosingMatch[1];
        for (let i = tagStack.length - 1; i >= 0; i--) {
            if (tagStack[i].name === tagName) {
                tagStack.splice(i, 1);
                break;
            }
        }
        return '';
    }

    const standaloneOpeningMatch = trimmed.match(/^<([a-zA-Z0-9][a-zA-Z0-9_-]*)(\s+[^>]*)?>$/);
    if (standaloneOpeningMatch) {
        const tagName = standaloneOpeningMatch[1];
        const attributes = standaloneOpeningMatch[2] ? standaloneOpeningMatch[2].trim() : '';
        const depth = tagStack.length;

        tagStack.push({ name: tagName, attributes, depth });

        const headerLevel = Math.min(depth + 1, 6);
        const headerPrefix = '#'.repeat(headerLevel);
        const escapedName = escapeMarkdownInHeader(tagName);
        const attrStr = attributes ? ` (${escapeMarkdownInHeader(attributes)})` : '';

        return `${headerPrefix} ${escapedName}${attrStr}\n`;
    }

    const inlineTagMatch = trimmed.match(/^<([a-zA-Z0-9][a-zA-Z0-9_-]*)(\s+[^>]*)?>(.+)<\/\1>$/);
    if (inlineTagMatch) {
        const tagName = inlineTagMatch[1];
        const attributes = inlineTagMatch[2] ? inlineTagMatch[2].trim() : '';
        const content = inlineTagMatch[3].trim();
        const depth = tagStack.length;

        const headerLevel = Math.min(depth + 1, 6);
        const headerPrefix = '#'.repeat(headerLevel);
        const escapedName = escapeMarkdownInHeader(tagName);
        const attrStr = attributes ? ` (${escapeMarkdownInHeader(attributes)})` : '';

        return `${headerPrefix} ${escapedName}${attrStr}\n\n${content}\n`;
    }

    const openingWithContentMatch = trimmed.match(/^<([a-zA-Z0-9][a-zA-Z0-9_-]*)(\s+[^>]*)?>(.+)$/);
    if (openingWithContentMatch && !openingWithContentMatch[3].includes('</')) {
        const tagName = openingWithContentMatch[1];
        const attributes = openingWithContentMatch[2] ? openingWithContentMatch[2].trim() : '';
        const content = openingWithContentMatch[3].trim();
        const depth = tagStack.length;

        tagStack.push({ name: tagName, attributes, depth });

        const headerLevel = Math.min(depth + 1, 6);
        const headerPrefix = '#'.repeat(headerLevel);
        const escapedName = escapeMarkdownInHeader(tagName);
        const attrStr = attributes ? ` (${escapeMarkdownInHeader(attributes)})` : '';

        if (content) {
            return `${headerPrefix} ${escapedName}${attrStr}\n\n${content}`;
        }
        return `${headerPrefix} ${escapedName}${attrStr}\n`;
    }

    return processContentLine(line);
}

function processContentLine(line: string): string {
    const codeSegments: string[] = [];
    let processed = line.trimStart();

    processed = processed.replace(/`[^`]+`/g, (match) => {
        const index = codeSegments.length;
        codeSegments.push(match);
        return `\x00CODE${index}\x00`;
    });

    processed = processed.replace(/<\/?[a-zA-Z0-9][a-zA-Z0-9_-]*(\s+[^>]*)?>/g, '');

    processed = processed.replace(/\x00CODE(\d+)\x00/g, (_, index) => codeSegments[parseInt(index)]);

    return processed;
}

function escapeMarkdownInHeader(text: string): string {
    return text.replace(/_/g, '\\_');
}

// preview

let tempFilePath: string | undefined;
let documentChangeListener: vscode.Disposable | undefined;

async function showPreview(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }

    const document = editor.document;
    const markdownContent = convertClaudeMdToMarkdown(document.getText());

    const tempDir = os.tmpdir();
    const originalName = path.basename(document.fileName, '.md');
    tempFilePath = path.join(tempDir, `${originalName}_preview.md`);

    fs.writeFileSync(tempFilePath, markdownContent, 'utf-8');

    const tempUri = vscode.Uri.file(tempFilePath);

    await vscode.commands.executeCommand('markdown.showPreviewToSide', tempUri);

    if (documentChangeListener) {
        documentChangeListener.dispose();
    }

    documentChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === document && tempFilePath) {
            const updatedContent = convertClaudeMdToMarkdown(event.document.getText());
            fs.writeFileSync(tempFilePath, updatedContent, 'utf-8');
        }
    });

    context.subscriptions.push(documentChangeListener);
}

// beautify: cascading indentation from tag depth

function beautifyDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const lines = document.getText().split(/\r?\n/);
    const result: string[] = [];
    const indent = '  ';
    let depth = 0;
    let inCodeBlock = false;
    let codeBlockDepth = 0;

    for (const line of lines) {
        if (/^(\s*)(`{3,}|~{3,})/.test(line)) {
            if (!inCodeBlock) {
                codeBlockDepth = Math.max(0, depth - 1);
                result.push(indent.repeat(codeBlockDepth) + line.trim());
                inCodeBlock = true;
            } else {
                result.push(indent.repeat(codeBlockDepth) + line.trim());
                inCodeBlock = false;
            }
            continue;
        }

        if (inCodeBlock) {
            result.push(indent.repeat(codeBlockDepth) + line.trimStart());
            continue;
        }

        const trimmed = line.trim();

        if (trimmed === '') {
            result.push('');
            continue;
        }

        if (/^<\/[a-zA-Z0-9][a-zA-Z0-9_-]*>\s*$/.test(trimmed)) {
            depth = Math.max(0, depth - 1);
            result.push(indent.repeat(depth) + trimmed);
            continue;
        }

        if (/^<[a-zA-Z0-9][a-zA-Z0-9_-]*(\s+[^>]*)?>$/.test(trimmed)) {
            result.push(indent.repeat(depth) + trimmed);
            depth++;
            continue;
        }

        if (/^#{1,6}\s+/.test(trimmed)) {
            result.push(trimmed);
            continue;
        }

        const contentDepth = Math.max(0, depth - 1);
        result.push(indent.repeat(contentDepth) + trimmed);
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );

    return [vscode.TextEdit.replace(fullRange, result.join('\n'))];
}

// activation

export function activate(context: vscode.ExtensionContext) {
    decoTypes = createDecoTypes();
    pairDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
        borderRadius: '3px'
    });
    context.subscriptions.push(pairDeco);
    context.subscriptions.push(diagCollection);

    const refresh = (editor: vscode.TextEditor) => {
        updateDecorations(editor);
        updateDiagnostics(editor.document);
    };
    vscode.window.visibleTextEditors.forEach(refresh);

    let updateTimer: ReturnType<typeof setTimeout> | undefined;

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) refresh(editor);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (updateTimer) clearTimeout(updateTimer);
            updateTimer = setTimeout(() => {
                vscode.window.visibleTextEditors
                    .filter(e => e.document === event.document)
                    .forEach(refresh);
            }, 100);
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
            updatePairHighlight(event.textEditor);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('claudemd')) {
                disposeDecoTypes();
                decoTypes = createDecoTypes();
                vscode.window.visibleTextEditors.forEach(refresh);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            parseCache.delete(document.uri.toString());
            diagCollection.delete(document.uri);
        })
    );

    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: 'claudemd' },
            new ClaudeMdFoldingRangeProvider()
        ),
        vscode.languages.registerFoldingRangeProvider(
            { language: 'markdown', pattern: '**/{CLAUDE,AGENT,claude,agent}.md' },
            new ClaudeMdFoldingRangeProvider()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('claudemd.beautify', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor');
                return;
            }

            const edits = beautifyDocument(editor.document);
            const workspaceEdit = new vscode.WorkspaceEdit();
            edits.forEach(edit => workspaceEdit.replace(editor.document.uri, edit.range, edit.newText));

            vscode.workspace.applyEdit(workspaceEdit).then(success => {
                if (success) {
                    vscode.window.showInformationMessage('Document beautified');
                }
            });
        }),
        vscode.commands.registerCommand('claudemd.preview', () => showPreview(context)),
        vscode.commands.registerCommand('claudemd.folding_range', () => {
            vscode.commands.executeCommand('editor.foldAll');
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            { language: 'claudemd' },
            { provideDocumentFormattingEdits: beautifyDocument }
        )
    );
}

export function deactivate() {
    disposeDecoTypes();
    if (tempFilePath && fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch {}
    }
    if (documentChangeListener) {
        documentChangeListener.dispose();
    }
}
