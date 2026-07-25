# ClaudeMD Syntax Highlighter

A Visual Studio Code extension for CLAUDE.md and AGENT.md files, the instruction files used by Claude and other AI coding assistants. These files mix regular markdown with XML-like tags, and no stock language mode highlights that combination well. This extension makes them readable.

## Features

- **Color-coded tags by nesting depth.** Every tag pair gets a color based on how deeply it is nested, cycling through a palette, so you can see the structure of the file at a glance. Opening and closing tags always share the same color.
- **Distinct colors for attributes.** Tag names, attribute names, and attribute values each get their own color, for example in `<rules priority="high">`.
- **Error detection.** Unclosed tags, closing tags with no opening tag, and improperly nested (crossing) tags are colored red and marked with a warning squiggle that explains what is wrong.
- **Tag pair highlighting.** Place the cursor on any tag and its matching partner lights up, no matter how far away it is.
- **Code stays untouched.** Fenced code blocks and inline backtick code get their own flat colors and are never mistaken for tags, so examples like `<<` or XML snippets inside code are safe.
- **Folding.** Collapse any tag block, markdown header section, or code block from the gutter.
- **Beautify.** One command indents the whole file into a clean cascading tree based on tag nesting.
- **Preview.** Renders the file as standard markdown, converting tags into headers, using the built-in VS Code preview.
- **Markdown support.** Headers, bold, italic, strikethrough, lists, links, and blockquotes are highlighted as usual alongside the tags.

## Installation

### From the VSIX file

1. Download the latest `.vsix` file from the [Releases page](https://github.com/revoconner/vscode-claudemd-syntax/releases).
2. In VS Code, open the Extensions view (`Ctrl+Shift+X`).
3. Click the three-dot menu at the top of the Extensions view and choose **Install from VSIX...**
4. Select the downloaded file and reload VS Code when prompted.

Alternatively, from a terminal:

```
code --install-extension vscode-claudemd-syntax-1.0.0.vsix
```

## Usage

Just open a file named `CLAUDE.md`, `claude.md`, `AGENT.md`, or `agent.md`. The extension detects it automatically and applies the highlighting. For any other file, click the language indicator in the status bar and select **ClaudeMD**.

### Commands

| Command | Shortcut | What it does |
| --- | --- | --- |
| ClaudeMD: Beautify Document | `Ctrl+Alt+B` | Re-indents the file into a nested tree |
| ClaudeMD: Open Preview | `Ctrl+Shift+V` | Opens a rendered markdown preview to the side |
| ClaudeMD: Fold All Regions | | Collapses all tags, headers, and code blocks |

All commands are also available from the right-click context menu and the Command Palette.

### Error messages

When a tag is colored red, hover over it to see why. The three cases are:

- **Tag is never closed**: an opening tag with no matching closing tag anywhere below it.
- **No matching opening tag**: a closing tag that nothing opened.
- **Not closed before another tag closes**: crossing tags, for example `<a> <b> </a> </b>`, which is invalid nesting.

Note that a closing tag must use a forward slash. A typo like `<\tag>` is invisible to the parser and will surface as "never closed" on the opening tag instead.

## Customization

All colors can be changed in Settings under **Extensions > ClaudeMD**, or in `settings.json`:

| Setting | Default | Description |
| --- | --- | --- |
| `claudemd.tagColors` | 6-color palette | Tag colors by nesting depth, cycles when deeper |
| `claudemd.attributeNameColor` | `#FFA657` | Attribute names |
| `claudemd.attributeValueColor` | `#C3E88D` | Quoted attribute values |
| `claudemd.codeBlockColor` | `#CE9178` | Fenced code blocks |
| `claudemd.inlineCodeColor` | `#D7BA7D` | Inline backtick code |
| `claudemd.invalidTagColor` | `#F44747` | Invalid tags |
| `claudemd.colorCodeBlocks` | `true` | Set to `false` to highlight code blocks by their language instead of a flat color |
| `claudemd.indentSize` | `2` | Spaces per indent level used by Beautify |

## What counts as a tag

A tag name starts and ends with a letter or digit and may contain `-` and `_` in between. Attributes follow the same naming rule and may optionally have a quoted value, like `<rules>`, `<rules draft>`, or `<rules priority="high" scope="all">`. Anything before an opening tag on the same line other than whitespace disqualifies it, and nothing inside backticks or fenced code is ever parsed as a tag.

## License

See the repository for license details.
