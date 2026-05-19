/**
 * client entry point. renders the App into #root.
 * uses preact for minimal bundle size (~3kb gz vs react's ~45kb).
 */

import { render } from 'preact';
import { App } from './App.js';

// keyframe for the loading spinner — injected once at mount
const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) render(<App />, root);
