import * as vscode from 'vscode';

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

interface XmlTag {
    name: string;
    line: number;
    indent: number;
    isOpening: boolean;
    isClosing: boolean;
    isSelfClosing: boolean;
    attributes: Map<string, string>;
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

// ============================================================================
// PARSING UTILITIES
// ============================================================================

function parseDocument(document: vscode.TextDocument): DocumentStructure {
    const xmlTags: XmlTag[] = [];
    const headers: MarkdownHeader[] = [];
    const horizontalRules: number[] = [];

    const xmlOpeningTagRegex = /<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?\s*>/g;
    const xmlClosingTagRegex = /<\/([a-zA-Z_][a-zA-Z0-9_-]*)>/g;
    const xmlSelfClosingRegex = /<([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^>]*)?\s*\/>/g;
    const headerRegex = /^(#{1,6})\s+(.+?)\s*$/;
    const horizontalRuleRegex = /^\s*([-*_]){3,}\s*$/;
    const attributeRegex = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

    // Track if we're inside a fenced code block
    let inCodeBlock = false;
    const codeBlockRegex = /^(\s*)(`{3,}|~{3,})/;

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        const text = line.text;
        const indent = text.length - text.trimStart().length;

        // Check for code block boundaries
        const codeMatch = text.match(codeBlockRegex);
        if (codeMatch) {
            inCodeBlock = !inCodeBlock;
            continue;
        }

        // Skip processing if inside code block
        if (inCodeBlock) {
            continue;
        }

        // Check for horizontal rules
        if (horizontalRuleRegex.test(text)) {
            horizontalRules.push(i);
            continue;
        }

        // Check for markdown headers
        const headerMatch = text.match(headerRegex);
        if (headerMatch) {
            headers.push({
                level: headerMatch[1].length,
                line: i,
                text: headerMatch[2]
            });
        }

        // Parse XML tags - self-closing first
        let match;
        while ((match = xmlSelfClosingRegex.exec(text)) !== null) {
            const attributes = new Map<string, string>();
            if (match[2]) {
                let attrMatch;
                while ((attrMatch = attributeRegex.exec(match[2])) !== null) {
                    attributes.set(attrMatch[1], attrMatch[2] || attrMatch[3] || attrMatch[4] || '');
                }
            }
            xmlTags.push({
                name: match[1],
                line: i,
                indent,
                isOpening: false,
                isClosing: false,
                isSelfClosing: true,
                attributes
            });
        }

        // Parse closing tags
        while ((match = xmlClosingTagRegex.exec(text)) !== null) {
            xmlTags.push({
                name: match[1],
                line: i,
                indent,
                isOpening: false,
                isClosing: true,
                isSelfClosing: false,
                attributes: new Map()
            });
        }

        // Parse opening tags (exclude self-closing)
        const textWithoutSelfClosing = text.replace(xmlSelfClosingRegex, '');
        while ((match = xmlOpeningTagRegex.exec(textWithoutSelfClosing)) !== null) {
            const attributes = new Map<string, string>();
            if (match[2]) {
                let attrMatch;
                const attrRegex = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
                while ((attrMatch = attrRegex.exec(match[2])) !== null) {
                    attributes.set(attrMatch[1], attrMatch[2] || attrMatch[3] || attrMatch[4] || '');
                }
            }
            xmlTags.push({
                name: match[1],
                line: i,
                indent,
                isOpening: true,
                isClosing: false,
                isSelfClosing: false,
                attributes
            });
        }
    }

    return { xmlTags, headers, horizontalRules };
}

// ============================================================================
// FOLDING PROVIDER
// ============================================================================

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
                // Find matching opening tag
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

            // Close any headers that are same level or higher
            while (headerStack.length > 0 && headerStack[headerStack.length - 1].level >= current.level) {
                const popped = headerStack.pop()!;
                const endLine = current.line - 1;
                if (endLine > popped.line) {
                    ranges.push(new vscode.FoldingRange(popped.line, endLine, vscode.FoldingRangeKind.Region));
                }
            }

            headerStack.push({ level: current.level, line: current.line });

            // If this is the last header, close it at the end of document
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

// ============================================================================
// PREVIEW FUNCTIONALITY
// ============================================================================

function convertToMarkdown(document: vscode.TextDocument): string {
    const lines = document.getText().split(/\r?\n/);
    const result: string[] = [];
    const structure = parseDocument(document);

    // Build a map of tag start lines to their nesting depth
    const tagDepthMap = new Map<number, number>();
    const tagNameMap = new Map<number, { name: string; attributes: Map<string, string> }>();
    const tagEndLines = new Set<number>();

    // Track horizontal rule positions for section resets
    const hrLines = new Set(structure.horizontalRules);

    // Calculate nesting depth for each opening tag
    let currentDepth = 0;
    let baseDepth = 0;
    const tagStack: { name: string; line: number }[] = [];

    for (const tag of structure.xmlTags) {
        // Reset depth at horizontal rules
        if (tag.line > 0) {
            for (const hrLine of hrLines) {
                if (hrLine < tag.line && hrLine > (tagStack.length > 0 ? tagStack[tagStack.length - 1].line : 0)) {
                    currentDepth = 0;
                    baseDepth = 0;
                    tagStack.length = 0;
                }
            }
        }

        if (tag.isOpening) {
            tagDepthMap.set(tag.line, currentDepth);
            tagNameMap.set(tag.line, { name: tag.name, attributes: tag.attributes });
            tagStack.push({ name: tag.name, line: tag.line });
            currentDepth++;
        } else if (tag.isClosing) {
            tagEndLines.add(tag.line);
            // Find matching opening tag
            for (let i = tagStack.length - 1; i >= 0; i--) {
                if (tagStack[i].name === tag.name) {
                    tagStack.splice(i, 1);
                    currentDepth = Math.max(0, currentDepth - 1);
                    break;
                }
            }
        } else if (tag.isSelfClosing) {
            tagDepthMap.set(tag.line, currentDepth);
            tagNameMap.set(tag.line, { name: tag.name, attributes: tag.attributes });
        }
    }

    // Get current markdown header base level
    let mdHeaderBaseLevel = 0;
    for (const header of structure.headers) {
        if (mdHeaderBaseLevel === 0 || header.level < mdHeaderBaseLevel) {
            mdHeaderBaseLevel = header.level;
        }
    }

    // Track if we're in a code block
    let inCodeBlock = false;
    const codeBlockRegex = /^(\s*)(`{3,}|~{3,})(\S*)?$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Handle code blocks
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

        // Skip closing tag lines
        if (tagEndLines.has(i)) {
            continue;
        }

        // Check if this line has an opening tag
        if (tagDepthMap.has(i)) {
            const depth = tagDepthMap.get(i)!;
            const tagInfo = tagNameMap.get(i)!;

            // Calculate header level based on depth (minimum H2 since H1 is for document title)
            const headerLevel = Math.min(depth + 2, 6);
            const headerPrefix = '#'.repeat(headerLevel);

            // Format attributes
            let attrString = '';
            if (tagInfo.attributes.size > 0) {
                const attrs: string[] = [];
                tagInfo.attributes.forEach((value, key) => {
                    attrs.push(`${key}="${value}"`);
                });
                attrString = ` (${attrs.join(', ')})`;
            }

            // Convert tag to header
            result.push(`${headerPrefix} ${tagInfo.name}${attrString}`);

            // Check if there's content after the tag on the same line
            const tagPattern = new RegExp(`<${tagInfo.name}(?:\\s+[^>]*)?>(.*)$`);
            const contentMatch = line.match(tagPattern);
            if (contentMatch && contentMatch[1].trim()) {
                result.push(contentMatch[1].trim());
            }
        } else {
            // Check if line contains inline XML (tag with content on same line)
            const inlineTagRegex = /<([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s+[^>]*)?>(.+?)<\/\1>/g;
            let processedLine = line;
            let match;

            while ((match = inlineTagRegex.exec(line)) !== null) {
                // For inline tags, just extract the content
                processedLine = processedLine.replace(match[0], `**${match[1]}**: ${match[2]}`);
            }

            // Remove standalone opening/closing tags from the line
            processedLine = processedLine.replace(/<\/?[a-zA-Z_][a-zA-Z0-9_-]*(?:\s+[^>]*)?>/g, '');

            if (processedLine.trim() || line.trim() === '') {
                result.push(processedLine);
            }
        }
    }

    return result.join('\n');
}

let previewPanel: vscode.WebviewPanel | undefined;

function getPreviewHtml(content: string, isDark: boolean): string {
    const bgColor = isDark ? '#1e1e1e' : '#ffffff';
    const textColor = isDark ? '#d4d4d4' : '#333333';
    const headerColor = isDark ? '#569cd6' : '#0066cc';
    const codeBlockBg = isDark ? '#2d2d2d' : '#f4f4f4';
    const inlineCodeBg = isDark ? '#3c3c3c' : '#e8e8e8';
    const borderColor = isDark ? '#404040' : '#dddddd';

    // Simple markdown to HTML conversion
    let html = content
        // Escape HTML first
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Code blocks (before other processing)
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code class="language-$1">$2</code></pre>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
        // Headers
        .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
        .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
        .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        // Bold
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/_([^_]+)_/g, '<em>$1</em>')
        // Strikethrough
        .replace(/~~(.+?)~~/g, '<del>$1</del>')
        // Lists
        .replace(/^[-*+]\s+(.+)$/gm, '<li>$1</li>')
        .replace(/^(\d+)\.\s+(.+)$/gm, '<li>$2</li>')
        // Horizontal rules
        .replace(/^[-*_]{3,}$/gm, '<hr>')
        // Links
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        // Paragraphs (wrap remaining lines)
        .replace(/^(?!<[hloupa]|<li|<hr|<pre|<code)(.+)$/gm, '<p>$1</p>')
        // Wrap consecutive li elements in ul
        .replace(/(<li>[\s\S]*?<\/li>)+/g, '<ul>$&</ul>');

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background-color: ${bgColor};
            color: ${textColor};
            padding: 20px 40px;
            line-height: 1.6;
            max-width: 900px;
            margin: 0 auto;
        }
        h1, h2, h3, h4, h5, h6 {
            color: ${headerColor};
            margin-top: 24px;
            margin-bottom: 16px;
            font-weight: 600;
            line-height: 1.25;
            border-bottom: 1px solid ${borderColor};
            padding-bottom: 8px;
        }
        h1 { font-size: 2em; }
        h2 { font-size: 1.5em; }
        h3 { font-size: 1.25em; }
        h4 { font-size: 1em; }
        h5 { font-size: 0.875em; }
        h6 { font-size: 0.85em; }
        p {
            margin: 12px 0;
        }
        .code-block {
            background-color: ${codeBlockBg};
            border: 1px solid ${borderColor};
            border-radius: 6px;
            padding: 16px;
            overflow-x: auto;
            margin: 16px 0;
        }
        .code-block code {
            background: none;
            padding: 0;
            font-size: 0.9em;
        }
        .inline-code {
            background-color: ${inlineCodeBg};
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 0.9em;
        }
        ul, ol {
            margin: 12px 0;
            padding-left: 24px;
        }
        li {
            margin: 4px 0;
        }
        hr {
            border: none;
            border-top: 2px solid ${borderColor};
            margin: 24px 0;
        }
        a {
            color: ${isDark ? '#4fc3f7' : '#0066cc'};
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        strong {
            font-weight: 600;
        }
        del {
            opacity: 0.7;
        }
    </style>
</head>
<body>
${html}
</body>
</html>`;
}

function showPreview(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }

    const document = editor.document;
    const markdownContent = convertToMarkdown(document);

    // Determine if using dark theme (Dark = 2, HighContrast = 3)
    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
                   vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

    if (previewPanel) {
        previewPanel.webview.html = getPreviewHtml(markdownContent, isDark);
        previewPanel.reveal(vscode.ViewColumn.Beside);
    } else {
        previewPanel = vscode.window.createWebviewPanel(
            'claudemdPreview',
            `Preview: ${document.fileName.split(/[\\/]/).pop()}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: false,
                retainContextWhenHidden: true
            }
        );

        previewPanel.webview.html = getPreviewHtml(markdownContent, isDark);

        previewPanel.onDidDispose(() => {
            previewPanel = undefined;
        }, null, context.subscriptions);
    }

    // Update preview when document changes
    const changeListener = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === document && previewPanel) {
            const updatedContent = convertToMarkdown(event.document);
            const isDarkNow = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
                              vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
            previewPanel.webview.html = getPreviewHtml(updatedContent, isDarkNow);
        }
    });

    context.subscriptions.push(changeListener);
}

// ============================================================================
// BEAUTIFY FUNCTIONALITY
// ============================================================================

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

        // Handle closing tags - decrease indent first, then add line
        const closingMatch = line.match(closingTagRegex);
        if (closingMatch) {
            currentIndent = Math.max(0, currentIndent - 1);
            result.push(indentString.repeat(currentIndent) + line.trim());
            continue;
        }

        // Handle self-closing tags - same indent, no change
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

    // Create a single edit that replaces the entire document
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );
    edits.push(vscode.TextEdit.replace(fullRange, result.join('\n')));

    return edits;
}

// ============================================================================
// EXTENSION ACTIVATION
// ============================================================================

export function activate(context: vscode.ExtensionContext) {
    console.log('ClaudeMD extension is now active');

    // Register folding range provider
    const foldingProvider = vscode.languages.registerFoldingRangeProvider(
        { language: 'claudemd', scheme: 'file' },
        new ClaudeMdFoldingRangeProvider()
    );
    context.subscriptions.push(foldingProvider);

    // Also register for markdown files named CLAUDE.md
    const foldingProviderMd = vscode.languages.registerFoldingRangeProvider(
        { language: 'markdown', pattern: '**/CLAUDE.md' },
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

    // Register folding range command (triggers re-calculation)
    const foldingCommand = vscode.commands.registerCommand('claudemd.folding_range', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        // Force folding provider to recalculate by running fold all command
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
    if (previewPanel) {
        previewPanel.dispose();
    }
}
