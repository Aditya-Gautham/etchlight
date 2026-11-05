import './style.css';
import './testbed';
import { App } from './ui/app';

const root = document.getElementById('app');
if (root) window.etchlight.app = new App(root);
