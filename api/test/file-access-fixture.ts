import { parseSecretBox } from '@deepcrm/schemas'

import { createFileAccessService } from '../src/services/file-access.js'

const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSJ9fQ=='

export const testFileAccess = createFileAccessService('https://files.example.test', parseSecretBox(keyring))
