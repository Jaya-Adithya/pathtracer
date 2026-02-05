import { searchForWorkspaceRoot } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );

function copyAssetsPlugin() {

	return {
		name: 'copy-assets',
		writeBundle( options, _bundle ) {

			const outDir = path.isAbsolute( options.dir )
				? options.dir
				: path.resolve( __dirname, options.dir || 'example/bundle' );
			const assetsSrc = path.resolve( __dirname, 'example', 'assets' );
			const assetsDest = path.join( outDir, 'assets' );
			if ( ! fs.existsSync( assetsSrc ) ) return;
			fs.mkdirSync( assetsDest, { recursive: true } );
			for ( const name of fs.readdirSync( assetsSrc ) ) {

				fs.copyFileSync( path.join( assetsSrc, name ), path.join( assetsDest, name ) );

			}
		},
	};

}

export default {

	root: './example/',
	base: '',
	build: {
		outDir: './example/bundle/',
		sourcemap: true,
		rollupOptions: {
			input: fs
				.readdirSync( './example/' )
				.filter( p => /\.html$/.test( p ) )
				.map( p => `./example/${ p }` ),
		},
		plugins: [ copyAssetsPlugin() ],
	},
	server: {
		fs: {
			allow: [
				// search up for workspace root
				searchForWorkspaceRoot( process.cwd() ),
			],
		},
	},
	optimizeDeps: {
    	exclude: [ 'three-mesh-bvh' ],
  	},
};
