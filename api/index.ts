import type { IncomingMessage, ServerResponse } from 'http';
import app from '../src/index';

export default (req: IncomingMessage, res: ServerResponse) => app(req, res);
