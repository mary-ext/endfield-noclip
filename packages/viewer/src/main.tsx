import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.tsx';
import './app.css';

const root = document.getElementById('root');
if (root === null) {
	throw new Error('#root is missing');
}
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
