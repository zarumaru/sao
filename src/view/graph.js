/* This file is part of Tryton.  The COPYRIGHT file at the top level of
   this repository contains the full copyright notices and license terms. */
(function() {
    'use strict';

    Sao.View.GraphXMLViewParser = Sao.class_(Sao.View.XMLViewParser, {
        init: function(view, exclude_field, fields) {
            Sao.View.GraphXMLViewParser._super.init.call(
                this, view, exclude_field, fields);
            this._xfield = null;
            this._yfields = [];
        },
        _node_attributes: function(node) {
            var node_attrs = {};
            for (var i = 0, len = node.attributes.length; i < len; i++) {
                var attribute = node.attributes[i];
                node_attrs[attribute.name] = attribute.value;
            }
            if (node_attrs.name) {
                if (!node_attrs.string && (node_attrs.name != '#')) {
                    var field = this.field_attrs[node_attrs.name];
                    node_attrs.string = field.string;
                }
            }
            return node_attrs;
        },
        _parse_graph: function(node, attributes) {
            [].forEach.call(node.childNodes, function(child) {
                this.parse(child);
            }.bind(this));
            var Widget = Sao.View.GraphXMLViewParser.WIDGETS[
                attributes.type || 'vbar'];
            var widget = new Widget(this.view, this._xfield, this._yfields);
            this.view.el.append(widget.el);
            this.view.widgets.root = widget;
        },
        _parse_x: function(node, attributes) {
            for (var i = 0; i < node.children.length; i++) {
                this._xfield = this._node_attributes(node.children[i]);
            }
        },
        _parse_y: function(node, attributes) {
            for (var i = 0; i < node.children.length; i++) {
                this._yfields.push(this._node_attributes(node.children[i]));
            }
        }
    });

    Sao.View.Graph = Sao.class_(Sao.View, {
        editable: false,
        view_type: 'graph',
        xml_parser: Sao.View.GraphXMLViewParser,
        init: function(screen, xml, children_field) {
            this.el = jQuery('<div/>', {
                'class': 'graph'
            });

            Sao.View.Graph._super.init.call(this, screen, xml);
        },
        display: function() {
            return this.widgets.root.display(this.group);
        }
    });

    Sao.View.Graph.Chart = Sao.class_(Object, {
        _chart_type: undefined,

        init: function(view, xfield, yfields) {
            this.view = view;
            this.xfield = xfield;
            this.yfields = yfields;
            this.el = jQuery('<div/>');
            this.el.uniqueId();
        },
        update_data: function(group) {
            var data = {};
            var record, yfield, key;
            var i, len, j, y_len;

            this.ids = {};
            data.columns = [['labels']];
            data.names = {};
            var key2columns = {};
            var fields2load = [this.xfield.name];
            for (i = 0, len = this.yfields.length; i < len; i++) {
                yfield = this.yfields[i];
                data.columns.push([yfield.name]);
                data.names[yfield.name] = yfield.string;
                key2columns[yfield.key || yfield.name] = i + 1;
                fields2load.push(yfield.name);
            }

            var prms = [];
            var set_data = function(index) {
                return function () {
                    record = group[index];
                    var x = record.field_get_client(this.xfield.name);
                    // c3 does not support moment
                    if (x && (x.isDate || x.isDateTime)) {
                        x = x.toDate();
                    }
                    data.columns[0][index + 1] = x;
                    this._add_id(x, record.id);

                    var column;
                    for (j = 0, y_len = this.yfields.length; j < y_len; j++) {
                        yfield = this.yfields[j];
                        key = yfield.key || yfield.name;
                        column = data.columns[key2columns[key]];
                        if (yfield.domain) {
                            var ctx = jQuery.extend({},
                                    Sao.session.current_session.context);
                            ctx.context = ctx;
                            ctx._user = Sao.session.current_session.user_id;
                            for (var field in group.model.fields) {
                                ctx[field] = record.field_get(field);
                            }
                            var decoder = new Sao.PYSON.Decoder(ctx);
                            if (!decoder.decode(yfield.domain)) {
                                column[index + 1] = 0;
                                continue;
                            }
                        }
                        if (yfield.name == '#') {
                            column[index + 1] = 1;
                        } else {
                            var value = record.field_get(yfield.name);
                            if (value && value.isTimeDelta) {
                                value = value.asSeconds();
                            }
                            column[index + 1] = value || 0;
                        }
                    }
                }.bind(this);
            }.bind(this);
            var load_field = function(record) {
                return function(fname) {
                    prms.push(record.load(fname));
                };
            };

            var r_prms = [];
            for (i = 0, len = group.length; i < len; i++) {
                record = group[i];
                fields2load.forEach(load_field(group[i]));

                for (j = 0, y_len = data.columns.length; j < y_len; j++) {
                    data.columns[j].push(undefined);
                }
                r_prms.push(
                        jQuery.when.apply(jQuery, prms).then(set_data(i)));
            }
            return jQuery.when.apply(jQuery, r_prms).then(function() {
                return data;
            });
        },
        _add_id: function(key, id) {
            if (!(key in this.ids)) {
                this.ids[key] = [];
            }
            this.ids[key].push(id);
        },
        display: function(group) {
            var update_prm = this.update_data(group);
            update_prm.done(function(data) {
                c3.generate(this._c3_config(data));
            }.bind(this));
            return update_prm;
        },
        _c3_config: function(data) {
            var c3_config = {};

            c3_config.bindto = '#' + this.el.attr('id');
            c3_config.data = data;
            c3_config.data.type = this._chart_type;
            c3_config.data.x = 'labels';
            c3_config.data.onclick = this.action.bind(this);

            var type = this.xfield.type;
            if ((type == 'date') || (type == 'datetime')) {
                var format_func, date_format, time_format;
                date_format = Sao.common.date_format(
                    this.view.screen.context.date_format);
                time_format = '%X';
                if (type == 'datetime') {
                    format_func = function(dt) {
                        return Sao.common.format_datetime(date_format,
                                time_format, moment(dt));
                    };
                } else {
                    format_func = function(dt) {
                        return Sao.common.format_date(date_format, moment(dt));
                    };
                }
                c3_config.axis = {
                    x: {
                        type: 'timeseries',
                        tick: {
                            format: format_func,
                        }
                    }
                };
            } else {
                c3_config.axis = {
                    x: {
                        type: 'category',
                    }
                };
            }
            var colors = {};
            for (var i = 0; i < this.yfields.length; i++) {
                var field = this.yfields[i];
                if (field.color) {
                    colors[field.name] = field.color;
                }
            }
            c3_config.data.color = function(color, column) {
                // column is an object when called for legend
                var name = column.id || column;
                return colors[name] || color;
            };
            return c3_config;
        },
        action: function(data, element) {
            var ids = this.ids[this._action_key(data)];
            var ctx = jQuery.extend({}, this.view.screen.group._context);
            delete ctx.active_ids;
            delete ctx.active_id;
            Sao.Action.exec_keyword('graph_open', {
                model: this.view.screen.model_name,
                id: ids[0],
                ids: ids
            }, ctx, false);
        },
        _action_key: function(data) {
            return data.x;
        }
    });

    Sao.View.Graph.VerticalBar = Sao.class_(Sao.View.Graph.Chart, {
        _chart_type: 'bar'
    });

    Sao.View.Graph.HorizontalBar = Sao.class_(Sao.View.Graph.Chart, {
        _chart_type: 'bar',
        _c3_config: function(data) {
            var config = Sao.View.Graph.HorizontalBar._super._c3_config
                .call(this, data);
            config.axis.rotated = true;
        }
    });

    Sao.View.Graph.Line = Sao.class_(Sao.View.Graph.Chart, {
        _chart_type: 'line'
    });

    Sao.View.Graph.Pie = Sao.class_(Sao.View.Graph.Chart, {
        _chart_type: 'pie',
        _c3_config: function(data) {
            var config = Sao.View.Graph.Pie._super._c3_config.call(this, data);
            var pie_columns = [], pie_names = {};
            var i, len;
            var labels, values;

            for (i = 0, len = data.columns.length; i < len; i++) {
                if (data.columns[i][0] == 'labels') {
                    labels = data.columns[i].slice(1);
                } else {
                    values = data.columns[i].slice(1);
                }
            }

            // Pie chart do not support axis definition.
            delete config.axis;
            delete config.data.x;
            var format_func;
            var type = this.xfield.type;
            if ((type == 'date') || (type == 'datetime')) {
                var date_format = Sao.common.date_format(
                    this.view.screen.context.date_format);
                var datetime_format = date_format + ' %X';
                if (type == 'datetime') {
                    format_func = function(dt) {
                        return Sao.common.format_datetime(datetime_format, dt);
                    };
                } else {
                    format_func = function(dt) {
                        return Sao.common.format_date(date_format, dt);
                    };
                }
            }
            var label;
            for (i = 0, len = labels.length; i < len; i++) {
                label = labels[i];
                if (format_func) {
                    label = format_func(label);
                }
                pie_columns.push([i, values[i]]);
                pie_names[i] = label;
            }

            config.data.columns = pie_columns;
            config.data.names = pie_names;
            return config;
        },
        _add_id: function(key, id) {
            var type = this.xfield.type;
            if ((type == 'date') || (type == 'datetime')) {
                var date_format = Sao.common.date_format(
                    this.view.screen.context.date_format);
                var datetime_format = date_format + ' %X';
                if (type == 'datetime') {
                    key = Sao.common.format_datetime(datetime_format, key);
                } else {
                    key = Sao.common.format_date(date_format, key);
                }
            }
            Sao.View.Graph.Pie._super._add_id.call(this, key, id);
        },
        _action_key: function(data) {
            return data.id;
        }
    });

    Sao.View.GraphXMLViewParser.WIDGETS = {
        'hbar': Sao.View.Graph.HorizontalBar,
        'line': Sao.View.Graph.Line,
        'pie': Sao.View.Graph.Pie,
        'vbar': Sao.View.Graph.VerticalBar,
    };
}());
