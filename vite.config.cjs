const fs = require('fs');
const path = require('path');

module.exports = {

	root: './example/',
	base: '',
	build: {
		outDir: './bundle/',
		sourcemap: true,
		rollupOptions: {
			input: fs
				.readdirSync( './example/' )
				.filter( p => /\.html$/.test( p ) )
				.map( p => `./example/${ p }` ),
		},
	},
	server: {
		fs: {
			allow: [
				// Use absolute path instead of searchForWorkspaceRoot
				path.resolve(process.cwd()),
			],
		},
	},
	optimizeDeps: {
    	exclude: [ 'three-mesh-bvh' ],
  	},
};
