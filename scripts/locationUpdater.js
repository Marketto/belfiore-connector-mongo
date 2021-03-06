const request = require('request-promise-native');
const JSZip = require('jszip');
const csvtojson = require('csvtojson');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const _ = require('lodash');

const locationResources = require('./location-resources.json');
const prepositionsAndArticles = require('./prepositions_and_articles.json');

const LICENSE_KEYS = Object.keys(locationResources.licenses);

const detinationPath = path.join(__dirname, '../src/asset');
const DEFAULT_CREATION_DATE = '1861-01-01';

const downloadUnzip = (uri) => request({
    method: 'GET',
    uri,
    resolveWithFullResponse: true,
    encoding: null
})
    .then(({body}) => body)
    .then(JSZip.loadAsync)
    .then(zip => zip.file(/\.csv$/i)[0].async('binarystring'));


const downloadText = (uri) => request({
    method: 'GET',
    uri,
    resolveWithFullResponse: true
})
    .then(({body}) => body);

const parseCsv = delimiter => file => csvtojson({
    trim: true,
    delimiter
}).fromString(file);

const downloadResource = (uri, delimiter) => ((/\.(?:zip|gz)$/i).test(uri) ? downloadUnzip(uri) : downloadText(uri))
    .then(parseCsv(delimiter));

const cleanField = (value) => {
    if (typeof value === 'number' && isNaN(value)) {
        return;
    }
    if(typeof value === 'object') {
        return cleanObject(value);
    }
    if (typeof value !== 'string') {
        return value;
    }
    const trimmed = (value || '').trim();
    if ((/^(?:n\.?\s*d\.?|-)$/i).test(value)) {
        return;
    }
    return trimmed || undefined;
};

const cleanObject = (obj) => {
    if (!obj) {
        return undefined;
    }
    const out = {};
    Object.entries(obj).forEach(([key, value]) => {
        const cleanValue = cleanField(value);
        if (cleanValue !== undefined && cleanValue !== null) {
            out[key] = cleanValue;
        }
    });
    if (!Object.keys(out).length) {
        return;
    }
    return out;
};

const fixName = (name) => {
    if (!name) {
        return;
    }
    return name.replace(/[^\s']+'?/gi, (word) => {
        const lowerWord = word.toLowerCase();
        if (prepositionsAndArticles.includes(word.toUpperCase())) {
            return lowerWord;
        }
        return _.capitalize(lowerWord);
    }).replace(/^[^\s']+/i, word => _.capitalize(word));
};

const dataMapper1 = defaultSourceCode => data => data
    .map(obj => cleanObject({
        belfioreCode: obj['Codice AT'] || obj['CODCATASTALE'],
        name: fixName(obj['Denominazione IT'] || obj['Denominazione (b)'] || obj['DENOMINAZIONE_IT']),
        // newIstatCode: obj['Codice Stato/Territorio_Figlio'],
        iso3166: {
            alpha2: obj['Codice ISO 3166 alpha2'],
            alpha3: obj['Codice ISO 3166 alpha3']
        },
        creationDate: obj['DATAISTITUZIONE'] && moment(obj['DATAISTITUZIONE'], 'YYYY-MM-DD').startOf('day').toISOString(),
        expirationDate: obj['STATO'] === 'C' && obj['DATACESSAZIONE'] && moment(obj['DATACESSAZIONE'], 'YYYY-MM-DD').endOf('day').toISOString() ||
            obj['Anno evento'] && moment(obj['Anno evento'], 'YYYY').endOf('year').toISOString(),
        province: obj['SIGLAPROVINCIA'],
        region: parseInt(obj['IDREGIONE']),
        istatCode: parseInt(obj['CODISTAT'] || obj['Codice ISTAT']),
        dataSource: obj['FONTE'] || defaultSourceCode
    }))
    .filter(({belfioreCode}) => belfioreCode);

const isEqual = (a, b, ...args) => b ? _.isEqual(a,b) && (!args.length || isEqual(a, ...args)) : !!a;

const merge = (...entries) => {
    const sortedEntries = _.cloneDeep(entries).sort((a,b) => moment(b.creationDate || DEFAULT_CREATION_DATE).diff(moment(a.creationDate || DEFAULT_CREATION_DATE),'day'));
    return cleanObject(_.mergeWith(...sortedEntries, (valD, valS, key) => {
        switch (key) {
        case 'creationDate':
            return valS && valD ? moment.min(moment(valD), moment(valS)).toISOString() : null;
        case 'expirationDate':
            return valD && valS ? moment.max(moment(valD), moment(valS)).toISOString() : null;
        case 'active':
            return valS || valD;
        default:
            return valD;
        }
    }));
};

const deDupes = data => Object.values(_.groupBy(data, 'belfioreCode')).map(entry => isEqual(...entry) ? entry[0] : merge(...entry));

const mergeLists = data => [[], []].concat(data).reduce((a, b) => [].concat(a).concat(b));
Promise.all(locationResources.resources.map(async ({uri, delimiter, defaultSourceCode}) => Promise
    .all([].concat(uri)
        .filter(uri => !!uri)
        .map(singleUri => downloadResource(singleUri, delimiter)
            .then(dataMapper1(defaultSourceCode))
            .then(deDupes)
        )
    )
    .then(mergeLists)
))
    .then(mergeLists)
    .then(data => new Promise((resolve, reject) => fs.writeFile(path.join(detinationPath, 'cities-countries.json'), JSON.stringify(data, null, 4), (err) => err ? reject(err) : resolve())));