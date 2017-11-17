"use strict";
///<reference path="../../../headers/common.d.ts" />
exports.__esModule = true;
var _ = require("lodash");
var dateMath = require("app/core/utils/datemath");
var moment = require("moment");
var Scanner = require("./scanner");
var durationSplitRegexp = /(\d+)(ms|s|m|h|d|w|M|y)/;
var SqlQuery = (function () {
    /** @ngInject */
    function SqlQuery(target, templateSrv, options) {
        this.target = target;
        this.templateSrv = templateSrv;
        this.options = options;
        target.resultFormat = 'time_series';
    }
    SqlQuery.prototype.replace = function (options) {
        var query = this.target.query, scanner = new Scanner(query), from = SqlQuery.convertTimestamp(SqlQuery.round(this.options.range.from, this.target.round)), to = SqlQuery.convertTimestamp(this.options.range.to), timeFilter = SqlQuery.getTimeFilter(this.options.rangeRaw.to === 'now'), i = this.templateSrv.replace(this.target.interval, options.scopedVars) || options.interval, interval = SqlQuery.convertInterval(i, this.target.intervalFactor || 1);
        try {
            var ast = scanner.toAST();
            if (ast.hasOwnProperty('$columns') && !_.isEmpty(ast.$columns)) {
                query = SqlQuery.columns(query);
            }
            else if (ast.hasOwnProperty('$rateColumns') && !_.isEmpty(ast.$rateColumns)) {
                query = SqlQuery.rateColumns(query);
            }
            else if (ast.hasOwnProperty('$rate') && !_.isEmpty(ast.$rate)) {
                query = SqlQuery.rate(query, ast);
            }
            else if (ast.hasOwnProperty('$event') && !_.isEmpty(ast.$event)) {
                query = this.event(options, query);
            }
        }
        catch (err) {
            console.log("Parse error: ", err);
        }
        query = this.templateSrv.replace(query, options.scopedVars, SqlQuery.interpolateQueryExpr);
        this.target.rawQuery = query
            .replace(/\$timeSeries/g, '(intDiv(toUInt32($dateTimeCol), $interval) * $interval) * 1000')
            .replace(/\$timeFilter/g, timeFilter)
            .replace(/\$table/g, this.target.database + '.' + this.target.table)
            .replace(/\$from/g, from)
            .replace(/\$to/g, to)
            .replace(/\$timeCol/g, this.target.dateColDataType)
            .replace(/\$dateTimeCol/g, this.target.dateTimeColDataType)
            .replace(/\$interval/g, interval)
            .replace(/(?:\r\n|\r|\n)/g, ' ');
        return this.target.rawQuery;
    };
    SqlQuery.prototype.event = function (options, query) {
        if (query.slice(0, 7) === '$event(') {
            var args = query.slice(7)
                .trim()
                .slice(0, -1), scanner = new Scanner(args), ast = scanner.toAST();
            var root = ast['root'];
            if (root.length === 0) {
                throw { message: 'Amount of arguments must more than 1 for $event func. Parsed arguments are: ' + root.join(', ') };
            }
            query = this._event(options, root[0], root[1]);
        }
        return query;
    };
    SqlQuery.prototype._event = function (options, event, aggregation) {
        if (aggregation === void 0) { aggregation = 'count()'; }
        event = this.templateSrv.replace(event, options.scopedVars);
        aggregation = aggregation.replace(/__\w+/ig, function (section) { return event + section; });
        return "\n        SELECT\n          $timeSeries as t,\n          " + aggregation + " AS " + event + "\n        FROM $table\n        WHERE $timeFilter\n          AND event = '" + event + "'\n        GROUP BY t\n        ORDER BY t\n      ";
    };
    // $columns(query)
    SqlQuery.columns = function (query) {
        if (query.slice(0, 9) === '$columns(') {
            var fromIndex = SqlQuery._fromIndex(query);
            var args = query.slice(9, fromIndex)
                .trim() // rm spaces
                .slice(0, -1), // cut ending brace
            scanner = new Scanner(args), ast = scanner.toAST();
            if (ast.root.length !== 2) {
                throw { message: 'Amount of arguments must equal 2 for $columns func. Parsed arguments are: ' + ast.root.join(', ') };
            }
            query = SqlQuery._columns(ast.root[0], ast.root[1], query.slice(fromIndex));
        }
        return query;
    };
    SqlQuery._columns = function (key, value, fromQuery) {
        if (key.slice(-1) === ')' || value.slice(-1) === ')') {
            throw { message: 'Some of passed arguments are without aliases: ' + key + ', ' + value };
        }
        var keyAlias = key.trim().split(' ').pop(), valueAlias = value.trim().split(' ').pop(), havingIndex = fromQuery.toLowerCase().indexOf('having'), having = "";
        if (havingIndex !== -1) {
            having = fromQuery.slice(havingIndex, fromQuery.length);
            fromQuery = fromQuery.slice(0, havingIndex);
        }
        fromQuery = SqlQuery._applyTimeFilter(fromQuery);
        return 'SELECT ' +
            't' +
            ', groupArray((' + keyAlias + ', ' + valueAlias + ')) as groupArr' +
            ' FROM (' +
            ' SELECT $timeSeries as t' +
            ', ' + key +
            ', ' + value + ' ' +
            fromQuery +
            ' GROUP BY t, ' + keyAlias +
            ' ' + having +
            ' ORDER BY t' +
            ') ' +
            'GROUP BY t ' +
            'ORDER BY t';
    };
    // $rateColumns(query)
    SqlQuery.rateColumns = function (query) {
        if (query.slice(0, 13) === '$rateColumns(') {
            var fromIndex = SqlQuery._fromIndex(query);
            var args = query.slice(13, fromIndex)
                .trim() // rm spaces
                .slice(0, -1), // cut ending brace
            scanner = new Scanner(args), ast = scanner.toAST();
            if (ast.root.length !== 2) {
                throw { message: 'Amount of arguments must equal 2 for $columns func. Parsed arguments are: ' + ast.root.join(', ') };
            }
            query = SqlQuery._columns(ast.root[0], ast.root[1], query.slice(fromIndex));
            query = 'SELECT t' +
                ', arrayMap(a -> (a.1, a.2/runningDifference( t/1000 )), groupArr)' +
                ' FROM (' +
                query +
                ')';
        }
        return query;
    };
    // $rate(query)
    SqlQuery.rate = function (query, ast) {
        if (query.slice(0, 6) === '$rate(') {
            var fromIndex = SqlQuery._fromIndex(query);
            if (ast.$rate.length < 1) {
                throw { message: 'Amount of arguments must be > 0 for $rate func. Parsed arguments are: ' + ast.$rate.join(', ') };
            }
            query = SqlQuery._rate(ast.$rate, query.slice(fromIndex));
        }
        return query;
    };
    SqlQuery._fromIndex = function (query) {
        var fromIndex = query.toLowerCase().indexOf('from');
        if (fromIndex === -1) {
            throw { message: 'Could not find FROM-statement at: ' + query };
        }
        return fromIndex;
    };
    SqlQuery._rate = function (args, fromQuery) {
        var aliases = [];
        _.each(args, function (arg) {
            if (arg.slice(-1) === ')') {
                throw { message: 'Argument "' + arg + '" cant be used without alias' };
            }
            aliases.push(arg.trim().split(' ').pop());
        });
        var rateColums = [];
        _.each(aliases, function (a) {
            rateColums.push(a + '/runningDifference(t/1000) ' + a + 'Rate');
        });
        fromQuery = SqlQuery._applyTimeFilter(fromQuery);
        return 'SELECT ' + '' +
            't' +
            ', ' + rateColums.join(',') +
            ' FROM (' +
            ' SELECT $timeSeries as t' +
            ', ' + args.join(',') +
            ' ' + fromQuery +
            ' GROUP BY t' +
            ' ORDER BY t' +
            ')';
    };
    SqlQuery._applyTimeFilter = function (query) {
        if (query.toLowerCase().indexOf('where') !== -1) {
            query = query.replace(/where/i, 'WHERE $timeFilter AND ');
        }
        else {
            query += ' WHERE $timeFilter';
        }
        return query;
    };
    SqlQuery.getTimeFilter = function (isToNow) {
        if (isToNow) {
            return '$timeCol >= toDate($from) AND $dateTimeCol >= toDateTime($from)';
        }
        else {
            return '$timeCol BETWEEN toDate($from) AND toDate($to) AND $dateTimeCol BETWEEN toDateTime($from) AND toDateTime($to)';
        }
    };
    // date is a moment object
    SqlQuery.convertTimestamp = function (date) {
        //retu1rn date.format("'Y-MM-DD HH:mm:ss'")
        if (_.isString(date)) {
            date = dateMath.parse(date, true);
        }
        return Math.ceil(date.valueOf() / 1000);
    };
    SqlQuery.round = function (date, round) {
        if (round === "" || round === undefined || round === "0s") {
            return date;
        }
        if (_.isString(date)) {
            date = dateMath.parse(date, true);
        }
        var coeff = 1000 * SqlQuery.convertInterval(round, 1);
        var rounded = Math.floor(date.valueOf() / coeff) * coeff;
        return moment(rounded);
    };
    SqlQuery.convertInterval = function (interval, intervalFactor) {
        var m = interval.match(durationSplitRegexp);
        if (m === null) {
            throw { message: 'Received duration is invalid: ' + interval };
        }
        var dur = moment.duration(parseInt(m[1]), m[2]);
        var sec = dur.asSeconds();
        if (sec < 1) {
            sec = 1;
        }
        return Math.ceil(sec * intervalFactor);
    };
    SqlQuery.interpolateQueryExpr = function (value, variable, defaultFormatFn) {
        // if no multi or include all do not regexEscape
        if (!variable.multi && !variable.includeAll) {
            return value;
        }
        if (typeof value === 'string') {
            return SqlQuery.clickhouseEscape(value, variable);
        }
        var escapedValues = _.map(value, function (v) {
            return SqlQuery.clickhouseEscape(v, variable);
        });
        return escapedValues.join(',');
    };
    SqlQuery.clickhouseEscape = function (value, variable) {
        var isDigit = true;
        // if at least one of options is not digit
        _.each(variable.options, function (opt) {
            if (opt.value === '$__all') {
                return true;
            }
            if (!opt.value.match(/^\d+$/)) {
                isDigit = false;
                return false;
            }
        });
        if (isDigit) {
            return value;
        }
        else {
            return "'" + value.replace(/[\\']/g, '\\$&') + "'";
        }
    };
    return SqlQuery;
}());
exports["default"] = SqlQuery;