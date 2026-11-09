function fConMasToggle(id) {
    $("#" + id).toggle();
};

function fConMasLockView() {
    $.blockUI({ message: $('#domMessage').html() });
};

function fConMasLockViewById(id) {
    $.blockUI({ message: $('#' + id).html() });
};

function fConMasLockViewToFront() {
    $.blockUI.defaults.baseZ = 21001;
    $.blockUI({ message: $('#domMessage').html() });
};
