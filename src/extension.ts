import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// TYPES AND INTERFACES

interface XmlTag {
    name: string;
    line: number;
    indent: number;
    isOpening: boolean;
    isClosing: boolean;
    isSelfClosing: boolean;
    attributes: Map<string, string>;
    startIndex: number;
    endIndex: number;
}

interface MarkdownHeader {
    level: number;
    line: number;
    text: string;
}

interface DocumentStructure {
    xmlTags: XmlTag[];
    headers: MarkdownHeader[];
    horizontalRules: number[];
}

// PARSING UTILITIES

/**
 * Remove content inside backticks to avoid parsing XML-like content within code
 */
function maskCodeContent(text: string): { masked: string; codeBlocks: string[] } {
    const codeBlocks: string[] = [];

    // Mask inline code (backticks) - handle multiple backticks first
    let masked = text.replace(/(`{2,})([^`]+?)\1/g, (match) => {
        const index = codeBlocks.length;
        codeBlocks.push(match);
        return `\x00CODE${index}\x00`;
    });

    // Mask single backtick inline code
    masked = masked.replace(/`([^`]+)`/g, (match) => {
        const index = codeBlocks.length;
        codeBlocks.push(match);
        return `\x00CODE${index}\x00`;
    });

    return { masked, codeBlocks };
}

/**
 * Restore masked code content
 */
function unmaskCodeContent(text: string, codeBlocks: string[]): string {
    return text.replace(/\x00CODE(\d+)\x00/g, (_, index) => codeBlocks[parseInt(index)]);
}

function parseDocumentText(text: string): DocumentStructure {
    const xmlTags: XmlTag[] = [];
    const headers: MarkdownHeader[] = [];
    const horizontalRules: number[] = [];

    const lines = text.split(/\r?\n/);

    // Track if we're inside a fenced code block
    let inCodeBlock = false;
    const codeBlockRegex = /^(\s*)(`{3,}|~{3,})/;
    const headerRegex = /^(#{1,6})\s+(.+?)\s*$/;
    const horizontalRuleRegex = /^\s*([-*_]){3,}\s*$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const indent = line.length - line.trimStart().length;

        // Check for code block boundaries
        const codeMatch = line.match(codeBlockRegex);
        if (codeMatch) {
            inCodeBlock = !inCodeBlock;
            continue;
        }

        // Skip processing if inside code block
        if (inCodeBlock) {
            continue;
        }

        // Check for horizontal rules
        if (horizontalRuleRegex.test(line)) {
            horizontalRules.push(i);
            continue;
        }

        // Check for markdown headers
        const headerMatch = line.match(headerRegex);
        if (headerMatch) {
            headers.push({
                level: headerMatch[1].length,
                line: i,
                text: headerMatch[2]
            });
        }

        // Mask code content before parsing XML tags
        const { masked, codeBlocks } = maskCodeContent(line);

        // Parse XML tags from masked content
        const xmlOpeningTagRegex = /<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?\s*>/g;
        const xmlClosingTagRegex = /<\/([a-zA-Z_][a-zA-Z0-9_-]*)>/g;
        const xmlSelfClosingRegex = /<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?\s*\/>/g;

        let match;

        // Parse self-closing tags
        while ((match = xmlSelfClosingRegex.exec(masked)) !== null) {
            const attributes = parseAttributes(match[2] || '');
            xmlTags.push({
                name: match[1],
                line: i,
                indent,
                isOpening: false,
                isClosing: false,
                isSelfClosing: true,
                attributes,
                startIndex: match.index,
                endIndex: match.index + match[0].length
            });
        }

        // Parse closing tags
        while ((match = xmlClosingTagRegex.exec(masked)) !== null) {
            xmlTags.push({
                name: match[1],
                line: i,
                indent,
                isOpening: false,
                isClosing: true,
                isSelfClosing: false,
                attributes: new Map(),
                startIndex: match.index,
                endIndex: match.index + match[0].length
            });
        }

        // Parse opening tags (exclude self-closing)
        const maskedWithoutSelfClosing = masked.replace(xmlSelfClosingRegex, (m) => ' '.repeat(m.length));
        while ((match = xmlOpeningTagRegex.exec(maskedWithoutSelfClosing)) !== null) {
            const attributes = parseAttributes(match[2] || '');
            xmlTags.push({
                name: match[1],
                line: i,
                indent,
                isOpening: true,
                isClosing: false,
                isSelfClosing: false,
                attributes,
                startIndex: match.index,
                endIndex: match.index + match[0].length
            });
        }
    }

    return { xmlTags, headers, horizontalRules };
}

function parseAttributes(attrString: string): Map<string, string> {
    const attributes = new Map<string, string>();
    const attrRegex = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let match;
    while ((match = attrRegex.exec(attrString)) !== null) {
        attributes.set(match[1], match[2] || match[3] || match[4] || '');
    }
    return attributes;
}

function parseDocument(document: vscode.TextDocument): DocumentStructure {
    return parseDocumentText(document.getText());
}

// FOLDING PROVIDER

class ClaudeMdFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        _token: vscode.CancellationToken
    ): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        const structure = parseDocument(document);

        // Create folding ranges for XML tags
        const tagStack: { name: string; line: number }[] = [];

        for (const tag of structure.xmlTags) {
            if (tag.isOpening) {
                tagStack.push({ name: tag.name, line: tag.line });
            } else if (tag.isClosing) {
                for (let i = tagStack.length - 1; i >= 0; i--) {
                    if (tagStack[i].name === tag.name) {
                        const startLine = tagStack[i].line;
                        const endLine = tag.line;
                        if (endLine > startLine) {
                            ranges.push(new vscode.FoldingRange(startLine, endLine, vscode.FoldingRangeKind.Region));
                        }
                        tagStack.splice(i, 1);
                        break;
                    }
                }
            }
        }

        // Create folding ranges for markdown headers
        const headerStack: { level: number; line: number }[] = [];
        const sortedHeaders = [...structure.headers].sort((a, b) => a.line - b.line);

        for (let i = 0; i < sortedHeaders.length; i++) {
            const current = sortedHeaders[i];
            const next = sortedHeaders[i + 1];

            while (headerStack.length > 0 && headerStack[headerStack.length - 1].level >= current.level) {
                const popped = headerStack.pop()!;
                const endLine = current.line - 1;
                if (endLine > popped.line) {
                    ranges.push(new vscode.FoldingRange(popped.line, endLine, vscode.FoldingRangeKind.Region));
                }
            }

            headerStack.push({ level: current.level, line: current.line });

            if (!next) {
                while (headerStack.length > 0) {
                    const popped = headerStack.pop()!;
                    const endLine = document.lineCount - 1;
                    if (endLine > popped.line) {
                        ranges.push(new vscode.FoldingRange(popped.line, endLine, vscode.FoldingRangeKind.Region));
                    }
                }
            }
        }

        // Create folding ranges for fenced code blocks
        let codeBlockStart: number | null = null;
        const codeBlockRegex = /^(\s*)(`{3,}|~{3,})/;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            if (codeBlockRegex.test(line)) {
                if (codeBlockStart === null) {
                    codeBlockStart = i;
                } else {
                    if (i > codeBlockStart) {
                        ranges.push(new vscode.FoldingRange(codeBlockStart, i, vscode.FoldingRangeKind.Region));
                    }
                    codeBlockStart = null;
                }
            }
        }

        return ranges;
    }
}

// PREVIEW FUNCTIONALITY

/**
 * Escape underscores in text to prevent markdown italic interpretation
 */
function escapeUnderscores(text: string): string {
    // Don't escape underscores that are already in code blocks or inline code
    return text.replace(/(?<!`)_(?!`)/g, '\\_');
}

/**
 * Convert ClaudeMD to standard Markdown
 */
function convertToMarkdown(text: string): string {
    const lines = text.split(/\r?\n/);
    const result: string[] = [];

    // Track code blocks
    let inCodeBlock = false;
    const codeBlockRegex = /^(\s*)(`{3,}|~{3,})(.*)$/;

    // Build tag depth tracking
    const structure = parseDocumentText(text);
    const tagDepthMap = new Map<number, number>();
    const tagInfoMap = new Map<number, { name: string; attributes: Map<string, string> }>();
    const tagEndLines = new Set<number>();

    // Track horizontal rules for section resets
    const hrLines = new Set(structure.horizontalRules);

    let currentDepth = 0;
    const tagStack: { name: string; line: number }[] = [];

    for (const tag of structure.xmlTags) {
        // Reset at horizontal rules
        for (const hrLine of hrLines) {
            if (hrLine < tag.line && (tagStack.length === 0 || hrLine > tagStack[tagStack.length - 1].line)) {
                currentDepth = 0;
                tagStack.length = 0;
            }
        }

        if (tag.isOpening) {
            tagDepthMap.set(tag.line, currentDepth);
            tagInfoMap.set(tag.line, { name: tag.name, attributes: tag.attributes });
            tagStack.push({ name: tag.name, line: tag.line });
            currentDepth++;
        } else if (tag.isClosing) {
            tagEndLines.add(tag.line);
            for (let i = tagStack.length - 1; i >= 0; i--) {
                if (tagStack[i].name === tag.name) {
                    tagStack.splice(i, 1);
                    currentDepth = Math.max(0, currentDepth - 1);
                    break;
                }
            }
        } else if (tag.isSelfClosing) {
            tagDepthMap.set(tag.line, currentDepth);
            tagInfoMap.set(tag.line, { name: tag.name, attributes: tag.attributes });
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Handle code blocks - pass through unchanged
        const codeMatch = line.match(codeBlockRegex);
        if (codeMatch) {
            inCodeBlock = !inCodeBlock;
            result.push(line);
            continue;
        }

        if (inCodeBlock) {
            result.push(line);
            continue;
        }

        // Skip closing tag lines (they become end of section)
        if (tagEndLines.has(i)) {
            // Add blank line after section ends
            result.push('');
            continue;
        }

        // Check if this line starts with an opening tag
        if (tagDepthMap.has(i)) {
            const depth = tagDepthMap.get(i)!;
            const tagInfo = tagInfoMap.get(i)!;

            // Convert depth to header level (depth 0 = H2, depth 1 = H3, etc.)
            // H1 is reserved for the document title
            const headerLevel = Math.min(depth + 2, 6);
            const headerPrefix = '#'.repeat(headerLevel);

            // Format tag name - escape underscores for markdown
            const escapedName = tagInfo.name.replace(/_/g, '\\_');

            // Format attributes
            let attrString = '';
            if (tagInfo.attributes.size > 0) {
                const attrs: string[] = [];
                tagInfo.attributes.forEach((value, key) => {
                    const escapedKey = key.replace(/_/g, '\\_');
                    attrs.push(`${escapedKey}="${value}"`);
                });
                attrString = ` (${attrs.join(', ')})`;
            }

            result.push(`${headerPrefix} ${escapedName}${attrString}`);
            result.push('');

            // Check if there's content after the tag on the same line
            const tagPattern = new RegExp(`<${tagInfo.name}(?:\\s+[^>]*)?>\\s*(.*)$`);
            const contentMatch = line.match(tagPattern);
            if (contentMatch && contentMatch[1].trim()) {
                result.push(contentMatch[1].trim());
            }
        } else {
            // Regular content line - remove any stray tags but preserve code
            const { masked, codeBlocks } = maskCodeContent(line);

            // Remove XML tags from non-code content
            let processed = masked.replace(/<\/?[a-zA-Z_][a-zA-Z0-9_-]*(?:\s+[^>]*)?>/g, '');

            // Restore code blocks
            processed = unmaskCodeContent(processed, codeBlocks);

            // Only add non-empty lines or preserve intentional blank lines
            if (processed.trim() || line.trim() === '') {
                result.push(processed);
            }
        }
    }

    return result.join('\n');
}

let previewPanel: vscode.WebviewPanel | undefined;
let tempFilePath: string | undefined;

async function showPreview(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }

    const document = editor.document;
    const markdownContent = convertToMarkdown(document.getText());

    // Create temp file for preview
    const tempDir = os.tmpdir();
    const originalName = path.basename(document.fileName, '.md');
    tempFilePath = path.join(tempDir, `${originalName}_preview.md`);

    // Write converted content to temp file
    fs.writeFileSync(tempFilePath, markdownContent, 'utf-8');

    // Open the temp file and show markdown preview
    const tempUri = vscode.Uri.file(tempFilePath);
    const tempDoc = await vscode.workspace.openTextDocument(tempUri);
    await vscode.window.showTextDocument(tempDoc, vscode.ViewColumn.Beside, true);

    // Trigger VSCode's built-in markdown preview
    await vscode.commands.executeCommand('markdown.showPreviewToSide', tempUri);

    // Close the temp document (keep preview open)
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    // Set up listener to update preview when original document changes
    const changeListener = vscode.workspace.onDidChangeTextDocument(async event => {
        if (event.document === document && tempFilePath) {
            const updatedContent = convertToMarkdown(event.document.getText());
            fs.writeFileSync(tempFilePath, updatedContent, 'utf-8');
            // The markdown preview should auto-refresh
        }
    });

    context.subscriptions.push(changeListener);
}

// BEAUTIFY FUNCTIONALITY

function beautifyDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const lines = document.getText().split(/\r?\n/);
    const result: string[] = [];

    const indentString = '  '; // 2 spaces
    let currentIndent = 0;
    let inCodeBlock = false;

    const codeBlockRegex = /^(\s*)(`{3,}|~{3,})/;
    const openingTagRegex = /^(\s*)<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?>(\s*)$/;
    const closingTagRegex = /^(\s*)<\/([a-zA-Z_][a-zA-Z0-9_-]*)>(\s*)$/;
    const selfClosingTagRegex = /^(\s*)<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?\/>\s*$/;
    const headerRegex = /^(\s*)(#{1,6}\s+.*)$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Handle code blocks - preserve as-is
        const codeMatch = line.match(codeBlockRegex);
        if (codeMatch) {
            inCodeBlock = !inCodeBlock;
            result.push(indentString.repeat(currentIndent) + line.trim());
            continue;
        }

        if (inCodeBlock) {
            result.push(line); // Preserve code block content exactly
            continue;
        }

        // Handle closing tags - decrease indent first
        const closingMatch = line.match(closingTagRegex);
        if (closingMatch) {
            currentIndent = Math.max(0, currentIndent - 1);
            result.push(indentString.repeat(currentIndent) + line.trim());
            continue;
        }

        // Handle self-closing tags
        const selfClosingMatch = line.match(selfClosingTagRegex);
        if (selfClosingMatch) {
            result.push(indentString.repeat(currentIndent) + line.trim());
            continue;
        }

        // Handle opening tags - add line, then increase indent
        const openingMatch = line.match(openingTagRegex);
        if (openingMatch) {
            result.push(indentString.repeat(currentIndent) + line.trim());
            currentIndent++;
            continue;
        }

        // Handle headers - no indent
        const headerMatch = line.match(headerRegex);
        if (headerMatch) {
            result.push(line.trim());
            continue;
        }

        // Handle empty lines
        if (line.trim() === '') {
            result.push('');
            continue;
        }

        // Handle all other content - apply current indent
        result.push(indentString.repeat(currentIndent) + line.trim());
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );
    edits.push(vscode.TextEdit.replace(fullRange, result.join('\n')));

    return edits;
}

// EXTENSION ACTIVATION

export function activate(context: vscode.ExtensionContext) {
    console.log('ClaudeMD extension is now active');

    // Register folding range provider
    const foldingProvider = vscode.languages.registerFoldingRangeProvider(
        { language: 'claudemd', scheme: 'file' },
        new ClaudeMdFoldingRangeProvider()
    );
    context.subscriptions.push(foldingProvider);

    // Also register for markdown files named CLAUDE.md or AGENT.md
    const foldingProviderMd = vscode.languages.registerFoldingRangeProvider(
        { language: 'markdown', pattern: '**/{CLAUDE,AGENT}.md' },
        new ClaudeMdFoldingRangeProvider()
    );
    context.subscriptions.push(foldingProviderMd);

    // Register beautify command
    const beautifyCommand = vscode.commands.registerCommand('claudemd.beautify', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        const document = editor.document;
        const edits = beautifyDocument(document);

        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const edit of edits) {
            workspaceEdit.replace(document.uri, edit.range, edit.newText);
        }

        vscode.workspace.applyEdit(workspaceEdit).then(success => {
            if (success) {
                vscode.window.showInformationMessage('Document beautified successfully');
            } else {
                vscode.window.showErrorMessage('Failed to beautify document');
            }
        });
    });
    context.subscriptions.push(beautifyCommand);

    // Register preview command
    const previewCommand = vscode.commands.registerCommand('claudemd.preview', () => {
        showPreview(context);
    });
    context.subscriptions.push(previewCommand);

    // Register folding range command
    const foldingCommand = vscode.commands.registerCommand('claudemd.folding_range', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        vscode.commands.executeCommand('editor.foldAll').then(() => {
            vscode.window.showInformationMessage('Folding ranges created');
        });
    });
    context.subscriptions.push(foldingCommand);

    // Register document formatting provider
    const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(
        { language: 'claudemd', scheme: 'file' },
        {
            provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
                return beautifyDocument(document);
            }
        }
    );
    context.subscriptions.push(formattingProvider);
}

export function deactivate() {
    // Clean up temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
            fs.unlinkSync(tempFilePath);
        } catch (e) {
            // Ignore cleanup errors
        }
    }
    if (previewPanel) {
        previewPanel.dispose();
    }
}
