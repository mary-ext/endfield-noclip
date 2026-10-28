// File System Access API pieces TypeScript's DOM lib doesn't ship (Chromium-only)

interface DirectoryPickerOptions {
	id?: string;
	mode?: 'read' | 'readwrite';
}

interface Window {
	showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}
