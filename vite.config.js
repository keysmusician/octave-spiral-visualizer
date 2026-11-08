import { defineConfig } from 'vite'

export default defineConfig({
	root: 'source',
	build: {
		outDir: '../dist',
		emptyOutDir: true
	}
})
