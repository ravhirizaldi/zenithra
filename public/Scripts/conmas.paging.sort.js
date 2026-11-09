function fConMasPageSortAction(column, actionTypeName) {
    if ($("#PageData_SortColumn").val() == column) {
        if ($("#PageData_SortDirection").val() == "ASC") {
            $("#PageData_SortDirection").val("DESC");
        } else {
            $("#PageData_SortDirection").val("ASC");
        }
    } else {
        $("#PageData_SortColumn").val(column);
        $("#PageData_SortDirection").val("ASC");
    }
    $("#ActionCommonType").val(actionTypeName);
    $("#conmasPageForm").trigger('submit');
    return false;
}
function fConMasPageSort(column) {
    if ($("#PageData_SortColumn").val() == column) {
        if ($("#PageData_SortDirection").val() == "ASC") {
            $("#PageData_SortDirection").val("DESC");
        } else {
            $("#PageData_SortDirection").val("ASC");
        }
    } else {
        $("#PageData_SortColumn").val(column);
        $("#PageData_SortDirection").val("ASC");
    }
    $("#conmasPageForm").trigger('submit');
    return false;
};

