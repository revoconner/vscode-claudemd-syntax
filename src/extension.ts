import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// TYPES

interface TagInfo {
    name: string;
    attributes: string;
    depth: number;
}

// CONVERSION - ClaudeMD to Standard Markdown

function convertClaudeMdToMarkdown(text: string): string {
    const lines = text.split(/\r?\n/);
    const output: string[] = [];

    // State tracking
    let inFencedCodeBlock = false;
    let fenceChar = '';
    let fenceLength = 0;

    // Tag stack for tracking depth
    const tagStack: TagInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for fenced code block start/end
        const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
        if (fenceMatch) {
            if (!inFencedCodeBlock) {
                // Starting a code block
                inFencedCodeBlock = true;
                fenceChar = fenceMatch[2][0];
                fenceLength = fenceMatch[2].length;
                output.push(line);
                continue;
            } else {
                // Check if this closes the code block
                const closingMatch = line.match(new RegExp(`^\\s*${fenceChar}{${fenceLength},}\\s*$`));
                if (closingMatch) {
                    inFencedCodeBlock = false;
                    output.push(line);
                    continue;
                }
            }
        }

        // Inside code block - pass through unchanged
        if (inFencedCodeBlock) {
            output.push(line);
            continue;
        }

        // Process line outside of code blocks
        const processedLine = processLine(line, tagStack);
        if (processedLine !== null) {
            output.push(processedLine);
        }
    }

    return output.join('\n');
}

function processLine(line: string, tagStack: TagInfo[]): string | null {
    const trimmed = line.trim();

    // Empty line
    if (trimmed === '') {
        return '';
    }

    // Check for standalone closing tag (entire line is just a closing tag)
    const standaloneClosingMatch = trimmed.match(/^<\/([a-zA-Z_][a-zA-Z0-9_-]*)>\s*$/);
    if (standaloneClosingMatch) {
        // Pop from tag stack
        const tagName = standaloneClosingMatch[1];
        for (let i = tagStack.length - 1; i >= 0; i--) {
            if (tagStack[i].name === tagName) {
                tagStack.splice(i, 1);
                break;
            }
        }
        return ''; // Replace closing tag line with empty line
    }

    // Check for standalone opening tag (entire line is just an opening tag)
    const standaloneOpeningMatch = trimmed.match(/^<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?>$/);
    if (standaloneOpeningMatch) {
        const tagName = standaloneOpeningMatch[1];
        const attributes = standaloneOpeningMatch[2] ? standaloneOpeningMatch[2].trim() : '';
        const depth = tagStack.length;

        tagStack.push({ name: tagName, attributes, depth });

        // Convert to header (depth 0 = ##, depth 1 = ###, etc.)
        const headerLevel = Math.min(depth + 2, 6);
        const headerPrefix = '#'.repeat(headerLevel);
        const escapedName = escapeMarkdownInHeader(tagName);
        const attrStr = attributes ? ` (${escapeMarkdownInHeader(attributes)})` : '';

        return `${headerPrefix} ${escapedName}${attrStr}\n`;
    }

    // Check for opening tag with content on same line (inline tag)
    // Pattern: <tag>content</tag> or <tag attr="val">content</tag>
    const inlineTagMatch = trimmed.match(/^<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?>(.+)<\/\1>$/);
    if (inlineTagMatch) {
        const tagName = inlineTagMatch[1];
        const attributes = inlineTagMatch[2] ? inlineTagMatch[2].trim() : '';
        const content = inlineTagMatch[3].trim();
        const depth = tagStack.length;

        const headerLevel = Math.min(depth + 2, 6);
        const headerPrefix = '#'.repeat(headerLevel);
        const escapedName = escapeMarkdownInHeader(tagName);
        const attrStr = attributes ? ` (${escapeMarkdownInHeader(attributes)})` : '';

        // Return header followed by content
        return `${headerPrefix} ${escapedName}${attrStr}\n\n${content}\n`;
    }

    // Check for opening tag at start of line with content following
    const openingWithContentMatch = trimmed.match(/^<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?>(.+)$/);
    if (openingWithContentMatch && !openingWithContentMatch[3].includes('</')) {
        const tagName = openingWithContentMatch[1];
        const attributes = openingWithContentMatch[2] ? openingWithContentMatch[2].trim() : '';
        const content = openingWithContentMatch[3].trim();
        const depth = tagStack.length;

        tagStack.push({ name: tagName, attributes, depth });

        const headerLevel = Math.min(depth + 2, 6);
        const headerPrefix = '#'.repeat(headerLevel);
        const escapedName = escapeMarkdownInHeader(tagName);
        const attrStr = attributes ? ` (${escapeMarkdownInHeader(attributes)})` : '';

        if (content) {
            return `${headerPrefix} ${escapedName}${attrStr}\n\n${content}`;
        }
        return `${headerPrefix} ${escapedName}${attrStr}\n`;
    }

    // Regular content line - preserve inline code, remove stray tags
    return processContentLine(line);
}

function processContentLine(line: string): string {
    // Preserve inline code by replacing temporarily
    const codeSegments: string[] = [];
    let processed = line;

    // Replace inline code with placeholders
    processed = processed.replace(/`[^`]+`/g, (match) => {
        const index = codeSegments.length;
        codeSegments.push(match);
        return `\x00CODE${index}\x00`;
    });

    // Remove any remaining XML tags from non-code content
    processed = processed.replace(/<\/?[a-zA-Z_][a-zA-Z0-9_-]*(\s+[^>]*)?>/g, '');

    // Restore inline code
    processed = processed.replace(/\x00CODE(\d+)\x00/g, (_, index) => codeSegments[parseInt(index)]);

    return processed;
}

function escapeMarkdownInHeader(text: string): string {
    // Escape underscores to prevent italic interpretation
    return text.replace(/_/g, '\\_');
}

// FOLDING PROVIDER

class ClaudeMdFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        _token: vscode.CancellationToken
    ): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        const text = document.getText();
        const lines = text.split(/\r?\n/);

        // Track tag positions for folding
        const tagStack: { name: string; line: number }[] = [];
        let inCodeBlock = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Track code blocks
            if (/^(\s*)(`{3,}|~{3,})/.test(line)) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    const startLine = i;
                    // Find end of code block
                    for (let j = i + 1; j < lines.length; j++) {
                        if (/^(\s*)(`{3,}|~{3,})\s*$/.test(lines[j])) {
                            ranges.push(new vscode.FoldingRange(startLine, j, vscode.FoldingRangeKind.Region));
                            i = j;
                            inCodeBlock = false;
                            break;
                        }
                    }
                }
                continue;
            }

            if (inCodeBlock) continue;

            // Check for opening tags
            const openMatch = line.match(/<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?>(?!.*<\/\1>)/);
            if (openMatch) {
                tagStack.push({ name: openMatch[1], line: i });
            }

            // Check for closing tags
            const closeMatch = line.match(/<\/([a-zA-Z_][a-zA-Z0-9_-]*)>/);
            if (closeMatch) {
                for (let j = tagStack.length - 1; j >= 0; j--) {
                    if (tagStack[j].name === closeMatch[1]) {
                        const startLine = tagStack[j].line;
                        if (i > startLine) {
                            ranges.push(new vscode.FoldingRange(startLine, i, vscode.FoldingRangeKind.Region));
                        }
                        tagStack.splice(j, 1);
                        break;
                    }
                }
            }

            // Check for markdown headers
            const headerMatch = line.match(/^(#{1,6})\s+/);
            if (headerMatch) {
                const level = headerMatch[1].length;
                // Find end of this header section
                for (let j = i + 1; j < lines.length; j++) {
                    const nextHeaderMatch = lines[j].match(/^(#{1,6})\s+/);
                    if (nextHeaderMatch && nextHeaderMatch[1].length <= level) {
                        if (j - 1 > i) {
                            ranges.push(new vscode.FoldingRange(i, j - 1, vscode.FoldingRangeKind.Region));
                        }
                        break;
                    }
                    if (j === lines.length - 1 && j > i) {
                        ranges.push(new vscode.FoldingRange(i, j, vscode.FoldingRangeKind.Region));
                    }
                }
            }
        }

        return ranges;
    }
}

// PREVIEW

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

    // Create temp file
    const tempDir = os.tmpdir();
    const originalName = path.basename(document.fileName, '.md');
    tempFilePath = path.join(tempDir, `${originalName}_preview.md`);

    fs.writeFileSync(tempFilePath, markdownContent, 'utf-8');

    const tempUri = vscode.Uri.file(tempFilePath);

    // Open preview using VSCode's built-in markdown preview
    await vscode.commands.executeCommand('markdown.showPreviewToSide', tempUri);

    // Clean up previous listener
    if (documentChangeListener) {
        documentChangeListener.dispose();
    }

    // Update preview when document changes
    documentChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === document && tempFilePath) {
            const updatedContent = convertClaudeMdToMarkdown(event.document.getText());
            fs.writeFileSync(tempFilePath, updatedContent, 'utf-8');
        }
    });

    context.subscriptions.push(documentChangeListener);
}

// BEAUTIFY

function beautifyDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const lines = document.getText().split(/\r?\n/);
    const result: string[] = [];
    const indent = '  ';
    let depth = 0;
    let inCodeBlock = false;

    for (const line of lines) {
        // Handle code blocks
        if (/^(\s*)(`{3,}|~{3,})/.test(line)) {
            if (!inCodeBlock) {
                result.push(indent.repeat(depth) + line.trim());
                inCodeBlock = true;
            } else {
                result.push(indent.repeat(depth) + line.trim());
                inCodeBlock = false;
            }
            continue;
        }

        if (inCodeBlock) {
            result.push(line); // Preserve exactly
            continue;
        }

        const trimmed = line.trim();

        // Empty line
        if (trimmed === '') {
            result.push('');
            continue;
        }

        // Closing tag - decrease depth first
        if (/^<\/[a-zA-Z_][a-zA-Z0-9_-]*>\s*$/.test(trimmed)) {
            depth = Math.max(0, depth - 1);
            result.push(indent.repeat(depth) + trimmed);
            continue;
        }

        // Opening tag only (no content, no closing on same line)
        if (/^<[a-zA-Z_][a-zA-Z0-9_-]*(\s+[^>]*)?>$/.test(trimmed)) {
            result.push(indent.repeat(depth) + trimmed);
            depth++;
            continue;
        }

        // Header - no indent
        if (/^#{1,6}\s+/.test(trimmed)) {
            result.push(trimmed);
            continue;
        }

        // Regular content
        result.push(indent.repeat(depth) + trimmed);
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );

    return [vscode.TextEdit.replace(fullRange, result.join('\n'))];
}

// ACTIVATION

export function activate(context: vscode.ExtensionContext) {
    console.log('ClaudeMD extension activated');

    // Folding provider for claudemd language
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: 'claudemd', scheme: 'file' },
            new ClaudeMdFoldingRangeProvider()
        )
    );

    // Folding provider for CLAUDE.md/AGENT.md files in markdown mode
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: 'markdown', pattern: '**/{CLAUDE,AGENT}.md' },
            new ClaudeMdFoldingRangeProvider()
        )
    );

    // Beautify command
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
        })
    );

    // Preview command
    context.subscriptions.push(
        vscode.commands.registerCommand('claudemd.preview', () => showPreview(context))
    );

    // Fold all command
    context.subscriptions.push(
        vscode.commands.registerCommand('claudemd.folding_range', () => {
            vscode.commands.executeCommand('editor.foldAll');
        })
    );

    // Document formatting provider
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            { language: 'claudemd', scheme: 'file' },
            { provideDocumentFormattingEdits: beautifyDocument }
        )
    );
}

export function deactivate() {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch {}
    }
    if (documentChangeListener) {
        documentChangeListener.dispose();
    }
}
