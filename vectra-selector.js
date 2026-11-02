// Vectra 0.15.0 selector compatibility, pinned source dec2dadc3bb158b06ac72fa9097bee729429a271.
/*
MIT License

Copyright (c) 2023-2026 Steven Ickman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

class ItemSelector {
    static select(metadata, filter) {
        // Treat null/undefined and {} as "no filter"
        if (filter == null || (typeof filter === 'object' && Object.keys(filter).length === 0)) {
            return true;
        }
        for (const key in filter) {
            switch (key) {
                case '$and':
                    if (!filter[key].every((f) => this.select(metadata, f))) {
                        return false;
                    }
                    break;
                case '$or':
                    if (!filter[key].some((f) => this.select(metadata, f))) {
                        return false;
                    }
                    break;
                default:
                    const value = filter[key];
                    if (value === undefined || value === null) {
                        return false;
                    }
                    else if (typeof value == 'object') {
                        if (!this.metadataFilter(metadata[key], value)) {
                            return false;
                        }
                    }
                    else {
                        if (metadata[key] !== value) {
                            return false;
                        }
                    }
                    break;
            }
        }
        return true;
    }
    static metadataFilter(value, filter) {
        if (value === undefined || value === null) {
            return false;
        }
        for (const key in filter) {
            switch (key) {
                case '$eq':
                    if (value !== filter[key]) {
                        return false;
                    }
                    break;
                case '$ne':
                    if (value === filter[key]) {
                        return false;
                    }
                    break;
                case '$gt':
                    if (typeof value != 'number' || value <= filter[key]) {
                        return false;
                    }
                    break;
                case '$gte':
                    if (typeof value != 'number' || value < filter[key]) {
                        return false;
                    }
                    break;
                case '$lt':
                    if (typeof value != 'number' || value >= filter[key]) {
                        return false;
                    }
                    break;
                case '$lte':
                    if (typeof value != 'number' || value > filter[key]) {
                        return false;
                    }
                    break;
                case '$in':
                    if (typeof value == 'boolean') {
                        return false;
                    }
                    else if (typeof value == 'string' && !filter[key].includes(value)) {
                        return false;
                    }
                    else if (!filter[key].some(val => typeof val == 'string' && val.includes(value))) {
                        return false;
                    }
                    break;
                case '$nin':
                    if (typeof value == 'boolean') {
                        return false;
                    }
                    else if (typeof value == 'string' && filter[key].includes(value)) {
                        return false;
                    }
                    else if (filter[key].some(val => typeof val == 'string' && val.includes(value))) {
                        return false;
                    }
                    break;
                default:
                    return value === filter[key];
            }
        }
        return true;
    }
}

module.exports = { select: (metadata, filter) => ItemSelector.select(metadata, filter) }
