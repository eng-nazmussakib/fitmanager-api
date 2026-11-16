/**
 * Same style as the Angular and React skeletons (4 spaces, single quotes, 160 columns). Nobody formats by hand:
 * Prettier runs on save and on commit.
 * @type {import('prettier').Config}
 */
export default {
    singleQuote: true,
    tabWidth: 4,
    printWidth: 160,
    semi: true,
    arrowParens: 'avoid',
    trailingComma: 'none',
    endOfLine: 'lf',
    overrides: [{ files: ['*.yml', '*.yaml', '*.json'], options: { tabWidth: 2 } }]
};
