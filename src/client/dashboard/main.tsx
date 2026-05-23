/**
 * client entry point. renders the App into #root.
 * uses preact for minimal bundle size (~3kb gz vs react's ~45kb).
 */

import { render } from 'preact';
import { App } from './App.js';

const root = document.getElementById('root');
if (root) render(<App />, root);
