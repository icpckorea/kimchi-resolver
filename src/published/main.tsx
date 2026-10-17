/**
 * Entry of the static public page (publish.html). Reads the embedded
 * `<script type="application/json" id="publish-data">`, validates it with
 * parsePublishState and renders the board, or an error panel (both in Korean or English, see ./i18n).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { PublishedApp, PublishedError, readPublishData } from './PublishedApp';

const result = readPublishData(document.getElementById('publish-data')?.textContent ?? null);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {result.ok ? <PublishedApp state={result.state} /> : <PublishedError errors={result.errors} />}
  </StrictMode>,
);
