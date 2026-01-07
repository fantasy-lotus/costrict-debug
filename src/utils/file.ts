import path from "path"

// Mapping table for file extensions to programming languages
const LANGUAGE_MAP: Record<string, string> = {
	// JavaScript/TypeScript
	".js": "JavaScript",
	".jsx": "JavaScript",
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".mjs": "JavaScript",
	".cjs": "JavaScript",

	// Web Frontend
	".html": "HTML",
	".htm": "HTML",
	".css": "CSS",
	".scss": "SCSS",
	".sass": "Sass",
	".less": "Less",
	".vue": "Vue",
	".svelte": "Svelte",

	// Python
	".py": "Python",
	".pyw": "Python",
	".pyi": "Python",
	".ipynb": "Jupyter Notebook",

	// Java Family
	".java": "Java",
	".kt": "Kotlin",
	".kts": "Kotlin",
	".scala": "Scala",
	".groovy": "Groovy",

	// C/C++
	".c": "C",
	".h": "C",
	".cpp": "C++",
	".cxx": "C++",
	".cc": "C++",
	".hpp": "C++",
	".hxx": "C++",

	// C#
	".cs": "C#",
	".csx": "C#",

	// Go
	".go": "Go",

	// Rust
	".rs": "Rust",

	// PHP
	".php": "PHP",
	".phtml": "PHP",

	// Ruby
	".rb": "Ruby",
	".rbw": "Ruby",

	// Swift
	".swift": "Swift",

	// Objective-C
	".m": "Objective-C",
	".mm": "Objective-C",

	// Shell Scripts
	".sh": "Shell",
	".bash": "Shell",
	".zsh": "Shell",
	".fish": "Shell",
	".ps1": "PowerShell",
	".bat": "Batch",
	".cmd": "Batch",

	// Data Formats
	".json": "JSON",
	".xml": "XML",
	".yaml": "YAML",
	".yml": "YAML",
	".toml": "TOML",
	".ini": "Config",
	".cfg": "Config",
	".conf": "Config",

	// Markup Languages
	".md": "Markdown",
	".mdx": "Markdown",
	".tex": "LaTeX",
	".rst": "Text",

	// SQL
	".sql": "SQL",

	// R
	".r": "R",
	".R": "R",

	// Dart
	".dart": "Dart",

	// Lua
	".lua": "Lua",

	// Perl
	".pl": "Perl",
	".pm": "Perl",

	// Others
	".dockerfile": "Dockerfile",
	".Dockerfile": "Dockerfile",
	".makefile": "Makefile",
	".Makefile": "Makefile",
	".cmake": "CMake",
	".gradle": "Gradle",
	".gitignore": "Text",
	".env": "Config",
}

export async function getLanguage(filePath: string): Promise<string> {
	// Get file extension
	const ext = path.extname(filePath).toLowerCase()

	// Handle special filenames (files without extensions but can be identified by language)
	const fileName = path.basename(filePath).toLowerCase()

	// Special filename mapping
	const specialFiles: Record<string, string> = {
		dockerfile: "Dockerfile",
		makefile: "Makefile",
		"cmakelist.txt": "CMake",
		"package.json": "JSON",
		"tsconfig.json": "JSON",
		"webpack.config.js": "JavaScript",
		"vite.config.js": "JavaScript",
		"rollup.config.js": "JavaScript",
		".gitignore": "Text",
		".eslintrc": "JSON",
		".prettierrc": "JSON",
	}

	// Check special filenames first
	if (specialFiles[fileName]) {
		return specialFiles[fileName]
	}

	// Find language by extension
	if (ext && LANGUAGE_MAP[ext]) {
		return LANGUAGE_MAP[ext]
	}

	// If no corresponding language is found, return Unknown
	return "Unknown"
}
