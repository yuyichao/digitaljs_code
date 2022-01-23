//

'use strict';

import { createHash } from 'crypto';

export function hash_sha512(data) {
    return createHash('sha512').update(data).digest('hex');
}
